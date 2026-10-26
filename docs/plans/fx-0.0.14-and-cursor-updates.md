# Plan — fx 0.0.14 and cursor-agent 2026.10.x harness updates

| Field | Value |
| --- | --- |
| Date | 2026-10-22 |
| Source | Pipeline "Alamo Pipeline (No Video)" goal (review https://fx.sh/changelog and https://cursor.com/docs/release-notes/sdk, check their code, fix or update agetor's fx and cursor harnesses); `docs/plans/fx-0.0.14-and-cursor-updates-investigation.md` (step 1); `docs/plans/fx-0.0.14-and-cursor-updates-grill.md` (step 2, decisions D1–D35); this step's own grounding and spikes P1–P10 (§2) |
| Flags | none |
| Gates | grilled (35 decisions, owner-answered) + plan approved by owner 2026-10-22, with Q1 = switch Plan → Auto on approve and one addition: migrate the `lastModel:fx = zai/glm-5.3-flash` pref (§8) |
| Branch | `feature/fx-and-cursor-updates` (tree clean apart from the three untracked plan docs) |
| Base SHA | `fbd68603afef778a618a94ca88e0c00997956afd` |

## 1. Objective & success criteria

Bring agetor's **fx** harness from fx 0.0.10 to **fx 0.0.14** (staying graceful down to 0.0.4) and its **cursor** harness from cursor-agent 2026.09.26 to **cursor-agent 2026.10.x** (2026.10.22-27dcf5f is installed now; it auto-updated from 2026.10.19 during this step). Replace the cursor-only boolean `fast` with a `speed` enum (`off | fast | ultrafast`) for every kind. Stay on the cursor-agent CLI, not `@cursor/sdk` (D26).

Done means:

1. **fx correctness on 0.0.14.** No `session/set_mode` is ever sent, so agetor never writes `~/.fx/settings.json`. When a harness's toggle is on (default on), profile MCP servers load on `session/new`, `session/resume` and `session/load`. A terminal `failed` recovery state shows as failed, never as an in-progress retry. The new recovery causes and actions get labels.
2. **fx features.** Efforts come from discovery first, and the curated table is refreshed. Off / Fast / Ultrafast tiers are discovered and applied over ACP. A follow-up sent mid-turn steers the live turn, falling back to the queue. Internal tool calls are hidden, MCP tool calls are labelled "server · tool", and structured notices become status lines. The "fx held this tool call" line also names `FX_REVIEW_MODEL`. Settings and `agetor harness ls` show a hint when the fx profile starts in Ask. The default model becomes `deepseek/deepseek-v4-flash`, and 3 retired rows are migrated.
3. **cursor.** Every run without `--force` passes `--trust`. A new `plan` mode passes `--mode plan` and backs the Code/Plan toggle. Read-only passes `--mode ask`. `thinking` events become coalesced thinking blocks. `result.usage` drives the run-row usage chip. Tool names are extracted robustly.
4. **speed.** `tasks.speed` and `agent_profiles.speed` replace the dropped `fast` columns, with the rows backfilled and the `lastFast:*` prefs rewritten to `lastSpeed:*`. The API and CLI accept `fast` as an alias and emit a derived `fast`. Stored JSON and bundles carrying `fast` still read. Bundles stay at v1 and carry `speed` plus a derived `fast`.
5. **Green.** `bun run typecheck` and the full `bun test` pass, apart from the 3 known pre-existing failures (§6). The Playwright suite is green, including the 4 new or extended flows (§5). CLAUDE.md and the README describe the new behaviour. Post-green live smokes pass on fx 0.0.14 (signed in, paced, Full access, `deepseek/deepseek-v4-flash`) and on cursor-agent (an untrusted scratch dir, Plan and Read-only).

## 2. Context & constraints

**Inputs.** The investigation brief (§1–§7) and the grill record (D1–D35, G1–G3) are binding; this plan does not restate them, it cites them. Code anchors below were re-read on `fbd68603`.

**Evidence gathered in this step (P1–P10).** Artifacts are under `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-bffb84f6-da1a-4f0b-a8e1-617789e7ce67/f01ebbd7-7837-4b31-9474-6affe56ad0fb/scratchpad/`. The fx 0.0.14 source is the investigation's checkout, `…/3ba4a5f8-2078-48a9-b697-36bb73c7a046/scratchpad/fx-src/repo` (tag `v0.0.14`).

| # | Question | Verdict | How measured / versions |
| --- | --- | --- | --- |
| P1 | Grill assumption 4: do fx 0.0.10 (and 0.0.14) accept `_meta.fx.profileMcpServers: true` on `session/new`, `session/resume` and `session/load`? | **Yes, no error on either version.** No version gate is needed. | `probe/meta.ts`, isolated HOME, dummy key, installed `~/.local/bin/fx` 0.0.10 and the spike's 0.0.14 binary |
| P2 | Grill assumption 7: does bun:sqlite support `ADD COLUMN … CHECK` and `DROP COLUMN`, and does anything reference `tasks.fast` / `agent_profiles.fast`? | **Yes.** SQLite **3.51.0** in bun 1.3.10 (dev) and in the packaged app's bun 1.3.13. ADD COLUMN with a CHECK, the backfill, DROP COLUMN, and CHECK enforcement on insert all worked. No index, trigger or view in `src/bun/migrations/*.sql` or in prod's `sqlite_master` names `fast`. Migrations 055/056/060/062/064 *write* `fast`; they run before the new migration on a fresh DB, so that is fine. | `dropcol.ts`; `/Applications/Agetor.app/Contents/MacOS/bun`; `grep`; read-only `sqlite3` on prod |
| P3 | Grill assumption 6: do `cursor-agent -p --trust --mode plan` and `--mode ask` run headlessly in an **untrusted** dir? | **Yes, rc 0 for both, with no MCP-approval stall,** so `--approve-mcps` is not needed. Both modes still emit `thinking` delta/completed (3 blocks in one turn), `result.usage {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, and inner tool keys `globToolCall`/`readToolCall` + `hookAdditionalContexts`/`toolCallId`/`startedAtMs`. `system/init` reports `permissionMode: "default"` for both. A `thinking` event carries no id, only `text` + `timestamp_ms`. | `cursor-plan/`, `cursor-ask/` under the scratchpad; cursor-agent **2026.10.22-27dcf5f** |
| P4 | How does fx 0.0.14 steering really work? | **Source, `src/acp/server.zig` `handleSteeringPrompt`/`publishSteeringOutcomes`, `libfx_steering.zig`.** (a) A steer is a `session/prompt` sent while a prompt runs, and it **must carry `_meta.fx.steer: true`**; without it fx answers "Prompt already in progress". (b) Its reply is **deferred until the turn ends** and is written **after** the main prompt's response. (c) A steer delivered to the model is answered `{stopReason, _meta:{fx:{steering:"absorbed"}}}`. One still queued at turn end is answered with a **JSON-RPC error −32600** "Steering prompt was not delivered because the turn ended first; send it as a new prompt", or, on a cancelled turn, `{stopReason:"cancelled", _meta.fx.steering:"dropped"}`. (d) A steer that arrives after the turn stopped taking input is started by fx itself as the **next turn in the same process**. (e) Limits: 64 KiB per message (−32602 "Steering prompt text exceeds the 64 KiB limit"), 1 MiB queued. (f) The capability is `initialize.result.agentCapabilities._meta.fx.steering === true`: live `true` on 0.0.14, no `_meta` on 0.0.10. **Correction to D17:** fx signals a non-cancel drop as an RPC error, not as `steering:"dropped"`. The plan handles both. | source + `probe/meta.ts` INIT line |
| P5 | What does `fx status --json` report as `permission_mode` on 0.0.14? | **The env override when `FX_PERMISSION_MODE` is set (`yolo` → `"yolo"`), otherwise the saved profile value (`"ask"` with `{"permission_mode":"ask"}` in `~/.fx/settings.json`), otherwise `"auto"`.** The D2 probe must therefore **strip `FX_PERMISSION_MODE`** from its env. `status --json` wrote nothing into an empty HOME. | isolated HOMEs h1/h2, fx 0.0.14 |
| P6 | How do the ACP `fast` and `ultrafast` options interact? | **Ultrafast wins** (`orchestrator.zig:6939`: `selected_fast_mode = config.fast_mode and !config.ultrafast_mode`), and setting one clears the other (`server.zig:3713`, `:3766`). The `fast` option exists only on models whose `models --json` entry has `fast:true`. 13 curated fx ids qualify; `ultrafast` exists only on `openai/gpt-6.1-sol` and `openai/gpt-6-astra` (unauthenticated 0.0.14 catalog). | source + `models.json` |
| P7 | What do structured notices need and look like? | **Advertise `clientCapabilities.session.notices` with any non-null value** (`server.zig:2486`, `notices != .null`). fx then sends `{sessionUpdate:"notice", severity, title}` (`types.zig:177`) instead of `[context] …` agent text (`prompt.zig:3271`). | source |
| P8 | Where does `_meta.fx.toolCall {internal, mcp?{server,tool}}` appear? | **Only on `tool_call`**, never on `tool_call_update` (`types.zig writeToolCall` :267). The mapper must remember internal ids to hide the matching results. | source |
| P9 | What is the full new recovery vocabulary? | Causes gain `connectivity_lost` and `compaction_prepared`. Actions gain `checking_liveness`. `requiredAction` gains `surface_stall` (not resumable). `state:"failed"` = `kind == terminal_provider_error` and `action != paused` (`types.zig:52-61`). New kinds: `manual_retry_without_fast`, `manual_recovered_without_fast`. | `src/core/shared/types.zig:311-345,425-434` |
| P10 | Exactly which curated fx effort sets changed? | **20 differ and 3 ids are missing** (table in §3.4). The ACP option equals `models[].efforts` plus `auto` (investigation S3). | Python diff of `MODEL_EFFORT_SUPPORT.fx` (`src/shared/types.ts:3289-3326`) against the 0.0.14 `models.json` |

**Code anchors** (line numbers at `fbd68603`):

- **fx driver** (`src/bun/fx-acp.ts`, 2976 lines): the nudge is `acpModeIdFor` `:2191` plus its call at `:2608-2613`. Handshakes: `initialize` `:2436-2453`, `session/resume` `:2491`, `session/load` `:2549`, `session/new` `:2583`. `applyFxEffort` is at `:2306`, the prompt send at `:2621-2628`, and the stopReason switch at `:2687-2737`. `mapFxUpdate` is at `:1630`; its `tool_call` case is `:1670` and the held/denied line `:1742`. `user_message_chunk` falls to the silent default (`:1964`). `FxUpdateCtx` is `:1613`. `FxLaunchOptions` is `:2789-2835`, and `spawnFxViaAcp` returns `writeInput: () => false` (`:2957-2965`). The header facts block is `:95-600`.
- **fx recovery** (`src/shared/fx-recovery.ts`): `FX_RECOVERY_STATES` `:29`, `WIRE_OBJECT_STATES` `:35`; the unknown state maps to `"active"` at `:92-94`. `CAUSE_LABELS`/`ACTION_LABELS` are `:126-146`, `fxRecoverySummaryLine` `:204`, `isFxRecoveryResumable` `:218`. RunPanel's live notice only renders `state === "active"` (`RunPanel.tsx:2551`). `agetor logs` prints progress only for `active` (`src/cli/commands/logs.ts:186-188`).
- **Discovery and status**: `parseFxModels` reads `ids` only (`src/bun/agent-discovery.ts:551-569`). The change signature hashes `id:efforts` only (`src/bun/model-discovery.ts:84`). `probeStatus` is at `src/bun/agent-status.ts:285-331`. Discovered efforts already win **for every kind** (`supportedEfforts`, `src/shared/types.ts:3416-3445`, keeps `auto` only for fx), so fx needs no picker change for efforts.
- **Orchestrator fx queue**: `fxTurnQueue` `:4585`, `sendFxTurn` `:4700` (the busy branch appends the user event and queues), `spawnFxRun` `:4781`, `drainFxQueue` `:4924`. The queue drains after **every** settle, cancelled included (`attachDoneHandler` `:2664-2711`). `ActiveRun` is `:193`. `SpawnedAgent` is defined in `src/bun/claude-tmux.ts:72`.
- **Cursor**: argv at `src/bun/agents.ts:595-635` (`ask` emits no flag at `:620-623`). `bestEffortToolName` is `src/bun/cursor-tmux.ts:141-153`, `mapCursorEvent` `:190-270` (`thinking` falls to `default`), `CursorSessionState` `:276`. Modes are `src/shared/types.ts:3604-3607` and `CODE_PLAN_MODE.cursor` `:3065`. The plan-approve route embeds the plan only for `task.mode === "ask"` (`src/bun/server.ts:6902`).
- **The `fast` sweep (G3)**: the real producers and consumers are `src/shared/types.ts:371,406,1527`, `agent-profile.ts:218`, `bundle.ts:77,781,1208`, `bundle-import.ts:86,341-459,674` (the fingerprint); `src/bun/db.ts:88,440,813,972-982,1061-1067,2045-2213`; `server.ts:463-489` (allow-list and coercion), `:1005-1057` (clone launch), `:4236-4399` (profile create, duplicate and patch), `:5152` (bound-field guard); `orchestrator.ts:1523,1532,1794,2772,3977,4178,4362,4528,4886,6093,6559`; `pipeline-runner.ts:814`; `bundle.ts:510`; `agents.ts:92,610`; the CLI (`api-client.ts:746-811`, `add.ts`, `manage.ts:36`, `agent-profile.ts:44-278`, `usage.ts`, `test-fixtures.ts`); and the webview (`NewTaskForm.tsx` with the `lastFast:` pref at `:329/634`, `TaskLaunchPickers.tsx`, `RunPanel.tsx:7135-7433`, `AgentProfileFormDialog.tsx`, `AgentProfileDetailsDialog.tsx`, `CloneProjectDialog.tsx`, `CreateTaskFromIssueDialog.tsx`, `ResolveConflictsDialog.tsx`, `lib/api.ts:512,773,1564`). Every other `fast` hit in `src` is English prose ("fast path", "fast-forward"). **71 test or spec files** build `fast:` fixtures (list in T11 and in the per-task ownership below).
- **Migrations**: 071 is the last one registered (`src/bun/migrate.test.ts:1141`). The kind-joined retirement template is `066_retire_gemini_3_7_and_3_5_flash.sql`. Preferences are a key/value table (`011_preferences.sql`).
- **Prod data** (read-only check): 808 cursor runs, all in `auto`. 2 fx tasks, both `zai/glm-5.3-flash` with effort null. The prefs are `lastFast:cursor=true`, `lastFast:{claude-code,codex,fx}=false` and `lastModel:fx=zai/glm-5.3-flash`.
- **e2e**: the fx stub `writeFxStubBin` (`e2e/fixtures.ts:125-150`) answers `--help`, `--version` (`0.0.4-fake`) and `models --json` with 3 ids (`zai/glm-5.3-flash`, `openai/gpt-5.2`, `e2e/discovered-only`). It does not answer `status --json`, which keeps the auth check failing open. `tsconfig.json` includes `e2e`, so specs are typechecked.

**Constraints carried from memory and house rules.** Dogfood only against `~/.agetor-dev` (`bun run dev`), never prod. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` first. This worktree has **no `node_modules`**, so run `bun install` before anything. Run Playwright as `bun node_modules/@playwright/test/cli.js test`, one Playwright process at a time. Check `uptime` before `bun test src/cli`; it hangs when the load is above 30. Live fx probes run in isolated HOMEs, and the fx live smoke is paced (≥25 s between turns; the free tier allows about 5 requests a minute). A CLI smoke uses `--help` or a fresh `--data-dir` only, because the CLI talks to the running prod core. Model-id migrations must be kind-joined (knowledge `79ea4a46`, `c1efe6a2`). Never edit an applied migration. Code and tests use synthetic harness ids only.

## 3. Approach & key decisions

The grill settled the *what*. These are the *how* decisions this plan adds; each is marked **[evidence]** or **[reasoning]**.

### 3.1 Speed contract (binding for every wave-1 task)

- **[reasoning] Types** (`src/shared/types.ts`): `export type Speed = "off" | "fast" | "ultrafast"` and `export const SPEEDS = ["off", "fast", "ultrafast"] as const satisfies readonly Speed[]`. `Task`, `AgentProfile` and `AgentProfileSnapshot` gain a **required** `speed: Speed`. Their `fast` becomes **optional and derived**: `fast?: boolean`, documented as "`speed !== "off"`, emitted for older clients (D13), never read by agetor code". `maxMode` is unchanged. This keeps each test fixture to a one-line edit (`fast: false` → `speed: "off"`). **Acceptance grep:** after wave 1, `grep -rnE '\.fast\b' src --include=*.ts --include=*.tsx` (run via `rg` or `grep -r`, not a zsh glob) matches only the derive sites (`toTask`, `toAgentProfile`, `snapshotFromProfile`, the bundle writer) and the alias readers.
- **[reasoning] Pure helpers** in a new **`src/shared/speed.ts`**, zero runtime imports outside `src/shared/`. It imports `cursorModelSupportsFast` from `types.ts`, and `types.ts` never imports it, so there is no cycle.
  - `isSpeed(v: unknown): v is Speed`.
  - `speedFromFast(fast: boolean): Speed` (`true` → `"fast"`, else `"off"`).
  - `resolveSpeedInput(body: { speed?: unknown; fast?: unknown }): { speed?: Speed } | { error: string }`. `speed` wins when both are present. An invalid `speed` returns `"speed must be one of off, fast, ultrafast"`, and a non-boolean `fast` returns `"fast must be a boolean"`. Neither present returns `{}`.
  - `supportedSpeeds(kind, model, effort, option?: { fast?: boolean; ultrafast?: boolean }): Speed[]`. For cursor: `cursorModelSupportsFast(model, effort) ? ["off", "fast"] : ["off"]`. For fx: `["off"]`, plus `"fast"` when `option.fast`, plus `"ultrafast"` when `option.ultrafast` (discovery only, D16). For every other kind: `["off"]`.
  - `SPEED_OPTIONS: AgentOption[]`, labelled Off / Fast / Ultrafast. The Ultrafast hint reads "Faster Gateway lane — costs more per token than Fast" (D16).
- **[reasoning] Discovery shape** (`src/shared/model-options.ts`): `DiscoveredModel` and `ModelOption` gain `fast?: boolean; ultrafast?: boolean`. Rule 8 copies them like `efforts`, including onto the unlisted-selected row.
- **[evidence P2] Storage**: migration `072_task_speed.sql` (§3.5). `tasks.update` and `agentProfiles.update` take `speed` in a patch; db-layer callers never pass `fast`.
- **[reasoning] API alias** (D13): `POST /tasks`, `PATCH /tasks/:id`, `POST/PATCH /agent-profiles`, `POST /agent-profiles/:id/duplicate` and the `/projects/clone` launch fields run the body through `resolveSpeedInput`. `ALLOWED_PATCH_FIELDS` gains `"speed"` and keeps `"fast"` (mapped). The bound-profile 409 guard compares the resolved `speed` against the row. Every Task and AgentProfile response carries `speed` plus the derived `fast` (`toTask`/`toAgentProfile` set both).
- **[reasoning] CLI alias**: `--speed <off|fast|ultrafast>` on `agetor add`, `agetor edit`, `agetor profile add` and `agetor profile edit`, with `--fast` ≡ `--speed fast` and `--no-fast` ≡ `--speed off`. A later flag wins, and the usage text says so. `agetor profile show` prints `speed: <tier>`. `agetor add`'s mutual-exclusion lists (`--profile`/`--pipeline`) include `--speed`.
- **[reasoning] Pickers**: a single new **`SpeedPicker`** (`src/mainview/components/kanban/SpeedPicker.tsx`) replaces the three cursor Fast switches.
  - Props: `{ options: readonly Speed[]; value: Speed; onChange(s: Speed): void; disabled?: boolean; testId: string }`.
  - It is a segmented button group. The root carries `data-testid={testId}` and `data-value={value}`; each option button carries `data-testid={`${testId}-${id}`}` and `aria-pressed`.
  - It renders `null` when `options.length <= 1 && value === "off"`.
  - A stored `value` not in `options` renders as one extra disabled segment, "Fast (not offered)" or "Ultrafast (not offered)", so a stored tier stays visible (mirrors model rule 6).
  - Test ids: `launch-speed` (TaskLaunchPickers), `new-task-speed` (NewTaskForm), `task-speed` (RunPanel task details). The old `launch-fast-toggle` and the NewTaskForm/RunPanel Fast switches are removed.
  - Auto-reset keeps today's behaviour for cursor: clear to `off` when `!cursorModelSupportsFast`. For fx it resets to `off` **only on a user model change** when the new model's tiers are known and exclude the value; it never resets on load, because discovery may not be ready (D16).
- **[reasoning] Prefs**: `lastSpeed:<kind>` (values `off|fast|ultrafast`) replaces `lastFast:<kind>`. NewTaskForm reads and writes it, and migration 072 rewrites the old keys.
- **[reasoning] Bundle** (D15): `BundleAgent` gains `speed: Speed` and keeps `fast: boolean`, written as `speed !== "off"`. The parser accepts `speed` (a strict enum; anything else is a field error naming the allowed values) and/or `fast` (boolean); `speed` wins. The plan, the rebind reset (`speed: "off"`) and `planFingerprint` carry `speed`. The version stays 1.

### 3.2 fx driver (binding for F1, F4, S1–S3)

- **[evidence G1, S3] D1, the nudge:** delete `acpModeIdFor` and the `session/set_mode` call. `FX_PERMISSION_MODE` stays the only mode channel. Update the `FxLaunchOptions.mode` doc and the header text that describes the `code` registry.
- **[evidence P1] D3, profile MCP servers:** `FxLaunchOptions.profileMcpServers?: boolean`, where `undefined` is treated as on. When it is on, `_meta: { fx: { profileMcpServers: true } }` is added to the `session/new`, `session/resume` and `session/load` params. When it is off, `_meta` is omitted entirely. `agents.ts` passes `harness.profileMcpServers !== false`.
- **[evidence P7] D19c, notices:** `initialize` sends `clientCapabilities: { fs: {…}, terminal: false, session: { notices: {} } }`. `mapFxUpdate` gains `case "notice"`, which returns one `status` chunk: `` `fx: ${title}` ``, prefixed `⚠ ` when `severity` is `warning` or `error`. The `[context]` heuristic stays as the fallback for fx ≤0.0.13.
- **[evidence P8] D19a/b, tool metadata:** `FxUpdateCtx` gains `internalToolIds: Set<string>`.
  - On a `tool_call` with `_meta.fx.toolCall.internal === true`, the `tool_use` JSON gains `"internal": true` and the id is remembered; the matching `tool_result` gains `"internal": true` too.
  - When `_meta.fx.toolCall.mcp` is present, the `tool_use` `name` becomes `` `${server} · ${tool}` ``, fx's own `name` (if different) moves into `title`, and `mcp: {server, tool}` is kept.
  - The rows are still persisted and hidden only at render time (§3.6).
- **[evidence P6] D11/D16, speed:** `FxLaunchOptions.speed?: Speed | null`, where `undefined` or `null` means skip reconciliation entirely. `applyFxSpeed(state, sessionResult, opts)` runs right after `applyFxEffort` at each of the three handshake points. It reads the `configOptions` entries `{id:"fast"}` and `{id:"ultrafast"}` (`currentValue` is `"true"`/`"false"`) and sets the desired values in this order: `ultrafast := speed === "ultrafast"` first, then `fast := speed === "fast"`. It sends `session/set_config_option {configId, value: "true"|"false"}` only for an option that is present with a different `currentValue`, and refreshes the current values from each response's `configOptions`. Breadcrumbs, emitted once per turn as status:
  - `fx: Fast isn't offered for <model> — running without it`;
  - `fx: Ultrafast isn't offered for <model> — running without it`;
  - `fx: couldn't set <Tier> — <fx message> — running without it`.

  A successful set is silent, an `off` with no options present is silent, and the turn is never failed (same posture as effort).
- **[reasoning] D20, the reviewer hint:** the held-line text (`:1742`) gains: `… or set FX_REVIEW_MODEL in this harness's environment (Settings → Harnesses) to a reviewer model your account can reach.`
- **[evidence P9] D5, recovery:** the parser keeps `"failed"` (§3.6). The driver's terminal-transition summary emission already calls `fxRecoverySummaryLine`, so F2's new `failed` branch is what produces the line. F1 verifies that path rather than adding a second one.
- **[evidence investigation §1a.8] D29:** `stopReason: "yielded"` stays in the default branch, with a comment explaining that agetor never sets a deadline. Comments that describe `usage_update {used, size, cost?}` now say `cost` is gone on 0.0.14 but still optional for older binaries.
- **[evidence P4] D17/D18, steering (wave 3, S1–S3):**
  - **Driver** (`fx-acp.ts`). `FxSessionState` gains `steeringSupported` (from `initialize.result.agentCapabilities._meta.fx.steering === true`), `promptInFlight` (true from the moment the main `session/prompt` is written until it resolves) and `pendingSteers: Map<rpcId, { text: string; outcome: Promise<"absorbed" | "dropped"> }>`.
    - `spawnFxViaAcp` returns `steer(line: string): boolean`. It returns `false` unless the session is unresolved, `steeringSupported`, `promptInFlight`, there is a `sessionId`, and the line is at most 64 KiB in UTF-8 (`Buffer.byteLength`). Otherwise it sends `session/prompt { sessionId, prompt: [{ type: "text", text: line }], _meta: { fx: { steer: true } } }` with no timeout, registers the outcome, and returns `true`.
    - Outcome mapping: a result with `_meta.fx.steering === "absorbed"` → absorbed. A result with `"dropped"`, any `RpcError`, or still pending after the grace → dropped.
    - Once the main prompt resolves, **before** the stopReason switch, `await settlePendingSteers(state, STEER_SETTLE_GRACE_MS = 2000)` runs. Each dropped steer then calls `opts.onSteerDropped?.(text)` and emits `fx didn't take your message before the turn ended — sending it as the next turn`.
    - This ordering guarantees the line is in `fxTurnQueue` before `done` resolves and `drainFxQueue` runs. Cancelled turns are handled the same way, because today's queue also drains after Stop (`orchestrator.ts:2711`).
    - Steered `user_message_chunk` replays (`_meta.fx.steering`) get an explicit silent case in `mapFxUpdate` (D18 dedupe: agetor already wrote its own user event at send time).
  - **Orchestrator** (S2). `ActiveRun.steer?: (line: string) => boolean`, copied in `registerActiveRun`. `sendFxTurn`'s busy branch calls `handle.steer?.(line)` first. On `true` it appends the user event to the active run and returns its id, without queueing. On `false` (unsupported, too large, or still in the handshake) it queues exactly as today.
  - **Spawn** (S2/S3). `spawnFxRun` passes `onSteerDropped` (push to `fxTurnQueue`) through `SpawnAgentArgs.onSteerDropped` and on into `FxLaunchOptions.onSteerDropped`.
  - **`SpawnedAgent`** (`claude-tmux.ts:72`) gains `steer?: (line: string) => boolean`.
  - **Accepted risk:** a steer that fx starts as its own in-process next turn, after input closed, is torn down when agetor kills the child. Its text is re-queued, so the model may see a few seconds of duplicate work.

### 3.3 Cursor (binding for F4, F5, F9)

- **[evidence S6, P3] D22, trust:** every cursor run whose argv does **not** contain `--force` adds `--trust`. Today that means `ask` and the new `plan`.
- **[evidence P3] D23, modes:** `AGENT_OPTIONS.cursor.modes` becomes three entries:
  - `auto`, "Auto (force)", unchanged;
  - `plan`, "Plan", hint "Read-only planning — cursor-agent --mode plan. Approve the plan to implement.";
  - `ask`, "Read-only", hint "Read-only Q&A — cursor-agent --mode ask. Answers questions, makes no edits.".

  `CODE_PLAN_MODE.cursor = { code: "auto", plan: "plan" }`. The argv adds `--mode plan` for `plan` and `--mode ask` for `ask`, after `--model`; `auto` is unchanged (`--force --sandbox disabled`). Unknown mode ids keep the house passthrough: no flag, plus `--trust`. No data migration: existing mode ids are unchanged, and prod has no `ask` rows.
- **[owner, Q1 = a] Plan approval in `plan` mode:** `POST /tasks/:id/plans/:planId/approve` on a cursor task whose `mode === "plan"` flips the task to `auto` (a direct `tasks.update`, never the PATCH route) **before** sending the approval message, and emits the status `plan approved — switched this task to Auto (force) so cursor can implement it`. A profile-bound task (`agentProfileId` set) keeps `plan`, and the approve response and a status line say: `plan approved, but this task's agent runs cursor in Plan mode — detach the agent or switch the mode to implement`. The `task.mode === "ask"` embed rule (`server.ts:6902`) extends to `plan` when the mode is *not* flipped.
- **[evidence S7, P3] D24, thinking:** `CursorSessionState` gains `thinking: { firstLineIndex: number; text: string } | null`. A `thinking/delta` event appends text and opens the block with its line index. `thinking/completed`, or any other event type arriving while a block is open, flushes one `thinking` chunk with `line_uuid` `` `cursor:thinking:${firstLineIndex}` ``, which stays stable across an offset-0 reattach replay. `mapCursorEvent` takes an optional `ctx` object carrying the accumulator, so existing call sites keep working.
- **[reasoning] D24, usage:** on `result`, when `usage` is a plain object, emit one status chunk `FX_USAGE_STATUS_PREFIX + JSON.stringify({ turn: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } })`, finite numbers only, with key `` `cursor:usage:${lineIndex}` ``. This reuses the existing sentinel, which is already suppressed by `isInternalStatusSentinel` on all three surfaces and parsed by `parseFxUsage`. RunPanel's chip is not kind-gated (`RunPanel.tsx:1797-1821`, `:5123`), so no new prefix is needed. F7 makes the tooltip wording harness-neutral ("usage", not "fx usage").
- **[evidence S7, P3] D25, tool names:** `bestEffortToolName` picks the first key ending in `ToolCall`, then the string fields `name`/`tool`/`tool_name`, then the first key that is not one of `hookAdditionalContexts`/`toolCallId`/`startedAtMs`/`completedAtMs`, then `"tool_call"`. `detectCursorPlan` depends on the result `createPlanToolCall` and needs no change.

### 3.4 fx catalog (binding for T1, T2)

- **[evidence G2] D21:** `DEFAULT_MODEL.fx = "deepseek/deepseek-v4-flash"`. Move its row to the top of `AGENT_OPTIONS.fx.models` and rewrite the `DEFAULT_MODEL` fx comment (the owner's signed-in catalog is 145 ids and lacks `zai/glm-5.3-flash` and `spacexai/grok-4.7`; fx's own compiled default is `spacexai/grok-4.7` since 0.0.11). `spacexai/grok-4.7` stays `catalogOnly`.
- **[evidence G2] D10:** remove `alibaba/qwen3-coder-plus`, `mistral/devstral-2` and `anthropic/claude-3-haiku` from `AGENT_OPTIONS.fx.models` and `MODEL_EFFORT_SUPPORT.fx`.
- **[evidence P10] D6, curated refresh.** New `MODEL_EFFORT_SUPPORT.fx` values (agetor order: max, xhigh, high, medium, low, minimal, none, auto). The other 13 sets are unchanged.

| id | new set |
| --- | --- |
| zai/glm-5v-turbo | high, medium, low, none, auto |
| zai/glm-4.7 | high, medium, low, none, auto |
| openai/gpt-5.2 | xhigh, high, medium, low, minimal, none, auto |
| openai/gpt-5.1-codex-max | high, medium, low, none, auto |
| openai/gpt-5.4-mini | xhigh, high, medium, low, minimal, none, auto |
| spacexai/grok-4.6 | xhigh, high, medium, low, auto |
| spacexai/grok-build-0.1 | high, medium, low, none, auto |
| moonshotai/kimi-k2.7-code | high, medium, low, none, auto |
| deepseek/deepseek-v4-flash | high, medium, low, none, auto |
| alibaba/qwen3.8-flash | xhigh, medium, low, auto |
| google/gemini-2.5-flash | high, medium, low, none, auto |
| anthropic/claude-opus-5 | max, xhigh, high, medium, low, none, auto |
| anthropic/claude-sonnet-5 | max, xhigh, high, medium, low, none, auto |
| openai/gpt-5.5 | xhigh, high, medium, low, minimal, none, auto |
| google/gemini-3.1-pro-preview | high, low, auto |
| google/gemini-3.8-flash | high, low, auto |
| anthropic/claude-fable-5.1 | max, xhigh, high, medium, low, auto |
| openai/gpt-5.6-sol | max, xhigh, high, medium, low, minimal, none, auto |
| deepseek/deepseek-v4-pro | max, high, low, none, auto |
| spacexai/grok-4.7 | xhigh, high, medium, low, auto |

- **[reasoning] D6, discovery first:** `parseFxModels` reads `models[]` when present, as `{id, label: name, efforts: [...efforts, "auto"] when non-empty, fast, ultrafast}`. With no `models[]` (fx ≤0.0.13) it falls back to `ids` (today's behaviour, no efforts). The `model-discovery.ts` signature hashes `id`, `label`, `efforts`, `fast` and `ultrafast`, so a flag-only change republishes `agent_models_changed`. Since `supportedEfforts` is already kind-agnostic, nothing else in the effort path changes; F3 confirms this for `createTask`'s default effort and the PATCH null-clear guard with a test.

### 3.5 Migrations (binding for T2, T3)

- **`072_task_speed.sql`** [evidence P2]: for each of `tasks` and `agent_profiles`, run `ALTER TABLE … ADD COLUMN speed TEXT NOT NULL DEFAULT 'off' CHECK (speed IN ('off','fast','ultrafast'))`, then `UPDATE … SET speed = CASE WHEN fast = 1 THEN 'fast' ELSE 'off' END`, then `ALTER TABLE … DROP COLUMN fast`. Then rewrite the prefs: `INSERT OR REPLACE INTO preferences (key, value, updated_at) SELECT 'lastSpeed:' || substr(key, 10), CASE WHEN value = 'true' THEN 'fast' ELSE 'off' END, updated_at FROM preferences WHERE key LIKE 'lastFast:%'`, followed by `DELETE FROM preferences WHERE key LIKE 'lastFast:%'`. The header comment names this as the repo's first `DROP COLUMN` (one-way door 1) and explains why it is safe: no index, trigger or view; SQLite 3.51.0; the old migrations that write `fast` run before it.
- **`073_harness_profile_mcp_servers.sql`**: `ALTER TABLE harnesses ADD COLUMN profile_mcp_servers INTEGER NOT NULL DEFAULT 1`. It is meaningful for fx-kind rows only (D4).
- **`074_retire_fx_models.sql`**: a kind-joined `UPDATE` (`… AND agent IN (SELECT id FROM harnesses WHERE kind = 'fx')`, and for `agent_profiles`, `harness_id IN (…)`) that sets `model = 'deepseek/deepseek-v4-flash'` where `model IN ('alibaba/qwen3-coder-plus','mistral/devstral-2','anthropic/claude-3-haiku')`. Plus the pref: `UPDATE preferences SET value = 'deepseek/deepseek-v4-flash' WHERE key = 'lastModel:fx' AND value IN ('alibaba/qwen3-coder-plus','mistral/devstral-2','anthropic/claude-3-haiku','zai/glm-5.3-flash')`. `zai/glm-5.3-flash` is included **for the pref only** (owner, at plan approval): the owner's signed-in account lacks it, but it is not retired, so `tasks`/`agent_profiles` rows on it stay as they are and the curated row remains. Following 066's rules, `updated_at` is untouched, frozen `tasks.agent_profile`/`tasks.pipeline_run` snapshots are **not** rewritten, the migration is idempotent, and orphan rows are left alone. The retired rows advertised no efforts, so no effort fix-up is needed.
- **Registry**: append the three ids to `src/bun/migrations/index.ts`, and change the "071 is the last registered" test to say 074.

### 3.6 Rendering (binding for F6, F7)

- **[reasoning] A new `src/shared/tool-visibility.ts`** exports `isHiddenToolEvent(stream: string, data: string): boolean`. It returns `true` for a `tool_use`/`tool_result` whose JSON has `internal === true`, with a cheap `'"internal":true'` substring check before parsing. RunPanel's event list (display and message search), `agetor logs` and the TUI dashboard all skip those events. Persisted rows are untouched (D19).
- **[evidence P9] Recovery** (`fx-recovery.ts`):
  - `FX_RECOVERY_STATES` and `WIRE_OBJECT_STATES` gain `"failed"`; an unknown state still maps to `active` (forward compatibility).
  - `fxRecoverySummaryLine({state:"failed"})` returns `` `${fxRecoveryNoticeText(p)} — fx stopped retrying this response.` ``.
  - `isFxRecoveryResumable` is `false` for `failed` and for `requiredAction: "surface_stall"`.
  - New labels: `connectivity_lost` "Connection lost", `compaction_prepared` "Context compacted", `checking_liveness` "checking the connection".
  - Copy that assumes "429 → paused" is reworded to "when fx pauses a response …", in the `paused` summary text and in RunPanel's `PausedRecoveryNotice`.
  - The auto-resume engine is unchanged (D5). Its gate (`latestResumableFxPause`) already rejects non-resumable states; F2 adds a test proving `failed` never schedules.

### Alternatives rejected

- **Keep `fast` and add a separate `ultrafast` boolean**: the owner rejected it (D12) in favour of one enum.
- **Pass `--ultrafast` on the fx argv**: it works for one process, but the ACP options are per session, are reported back in `configOptions`, and can be reset to `off` on a resumed session. The argv flag can't turn a resumed session's tier off.
- **Version-gate the `profileMcpServers` meta**: not needed (P1).
- **A new usage sentinel for cursor**: the existing `fx-usage:` sentinel is already suppressed and parsed everywhere; a second prefix would add a fourth surface to keep in sync.
- **Steering via `writeInput`**: `writeInput` returns a boolean synchronously, but the steer outcome arrives at turn end. A separate `steer` keeps today's fold/queue contract for every other kind.

## 4. Work breakdown — implementation tasks

Every task runs `bun run typecheck` and its owned tests before it reports done. Within a wave, no two tasks share a file (validated in §6). The unit tests a task breaks or adds are owned by **that** task (house style, `docs/plans/fx-0.0.10-compat.md`), and §5 lists them per layer.

### Wave 1 — speed contract, catalog, storage (all kinds; no runtime fx or cursor behaviour change)

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared contracts: §3.1 types and helpers, §3.3 cursor modes and `CODE_PLAN_MODE`, §3.4 catalog (default, retire 3, refresh 20), `Harness.profileMcpServers?: boolean` ("absent ⇒ on"), `HarnessStatus.fxProfilePermissionMode?: string \| null` (fx ≥0.0.14 `status --json` `permission_mode`, read without `FX_PERMISSION_MODE`), `FxRecoveryState` + `"failed"`, the `FX_USAGE_STATUS_PREFIX` doc (cost dropped on 0.0.14; cursor reuses it), and `snapshotFromProfile` writing `speed` + derived `fast` | `src/shared/types.ts`, `src/shared/speed.ts` (new), `src/shared/model-options.ts`, `src/shared/agent-profile.ts`, `src/shared/types.test.ts`, `src/shared/speed.test.ts` (new), `src/shared/model-options.test.ts`, `src/shared/agent-profile.test.ts`, `src/shared/pipeline.test.ts`, `src/bun/effort-support.test.ts` | — | `supportedSpeeds` matrix (cursor fast-capable vs not; fx flags; claude-code → `["off"]`); `resolveSpeedInput` precedence and errors; `supportedEfforts("fx","deepseek/deepseek-v4-flash")` ids = high, medium, low, none, auto; the 3 retired ids are absent from both fx tables; keys of `MODEL_EFFORT_SUPPORT.fx` and `AGENT_OPTIONS.fx.models` still match both ways; `DEFAULT_MODEL.fx` is the first fx row; `supportedModes("cursor", …)` lists auto/plan/ask; rule 8 copies `fast`/`ultrafast` |
| T2 | Migrations 072/073/074 per §3.5 and the registry | `src/bun/migrations/072_task_speed.sql`, `073_harness_profile_mcp_servers.sql`, `074_retire_fx_models.sql` (all new), `src/bun/migrations/index.ts`, `src/bun/migrate.test.ts` | — | Hand-built-table tests (the 060 test's pattern): `fast` 1/0 → `fast`/`off` on both tables; the `fast` column is gone (`PRAGMA table_info`); `lastFast:cursor=true` → `lastSpeed:cursor=fast` and no `lastFast:*` remains; the CHECK rejects `'bogus'`; 073 defaults existing rows to 1; 074 rewrites fx-kind rows only (a cursor/codex row with the same literal is untouched); `lastModel:fx` moves from each of the 3 retired ids **and** from `zai/glm-5.3-flash`, while a `zai/glm-5.3-flash` task or profile row is left alone; the migration is idempotent; "074 is the last registered"; the full-migration fresh-DB test passes |
| T3 | db layer: `TaskRow`/`AgentProfileRow` `speed`; `toTask`/`toAgentProfile` emit `speed` + derived `fast`; insert/update SQL (`db.ts:972-1067`, `:2169-2213`); `parseAgentProfileSnapshot` (`:395-445`) reads `speed`, else `fast` → `speedFromFast`, else `off`, and the pipeline-run `snapshot.profiles` parse goes through it; the `agentProfiles` insert/update inputs take `speed`; `harnesses` read/insert/update the `profile_mcp_servers` column (`toHarness` always sets `profileMcpServers`) | `src/bun/db.ts`, `src/bun/agent-profiles.test.ts`, `src/bun/harnesses.test.ts`, `src/bun/db-speed.test.ts` (new) | — (codes against T1/T2) | Round trip for `speed` on tasks and profiles; a legacy snapshot JSON `{fast:true}` reads as `speed:"fast"` and `{}` as `off`; `tasks.update({speed})` persists; harness `profileMcpServers` round-trips and defaults to true |
| T4 | Server routes: §3.1 API alias on every listed route (`server.ts:463-489`, `:1005-1057`, `:4236-4399`, `:5152`), `"speed"` in `ALLOWED_PATCH_FIELDS`, the bound guard; `POST/PATCH /harnesses` accept `profileMcpServers: boolean` (400 on a non-boolean) | `src/bun/server.ts`, `src/bun/agent-profiles-endpoint.test.ts`, `src/bun/duplicate-agent-profile.test.ts`, `src/bun/clone-endpoint.test.ts`, `src/bun/server-speed-alias.test.ts` (new), `src/bun/harnesses-profile-mcp-endpoint.test.ts` (new) | — | `PATCH {fast:true}` → `speed:"fast"`; `{speed:"ultrafast", fast:false}` → ultrafast; `{speed:"x"}` → 400 with the T1 message; the bound task 409 fires on a speed change (via `speed` or `fast`) and passes on a same-value resend; GET responses carry both fields; the harness toggle persists and a non-boolean 400s |
| T5 | Spawn and orchestration plumbing: `AgentRunOptions.speed?: Speed \| null` replaces `fast`; cursor `cursorModelArg(model, effort, opts.speed === "fast", maxMode)`; every orchestrator spawn site passes `speed: task.speed`; profile drift (`:1523`) compares `speed`; the agent-switch reset (`:2772`) sets `speed: "off"`; `createTask` input `speed?: Speed` (`:6559`); `pipeline-runner.ts:814` copies `speed` | `src/bun/agents.ts`, `src/bun/orchestrator.ts`, `src/bun/pipeline-runner.ts`, `src/bun/agents.test.ts`, `src/bun/orchestrator-agent-profiles.test.ts`, `src/bun/orchestrator-fx.test.ts`, `src/bun/pipeline-runner.test.ts`, `src/bun/pipeline-runner-checkout-branch.test.ts`, `src/bun/pipelines.test.ts`, `src/bun/pipelines-endpoint.test.ts` | — | The cursor argv tests are rewritten in `speed` terms, with byte-identical argv for the same inputs; an unstarted profile-bound task picks up a profile speed change at first run; an fx task's `speed` reaches `AgentRunOptions` (the fx driver ignores it until wave 2) |
| T6 | Bundle per §3.1 (D15) | `src/shared/bundle.ts`, `src/shared/bundle-import.ts`, `src/bun/bundle.ts`, `src/shared/bundle.test.ts`, `src/shared/bundle-import.test.ts`, `src/bun/bundle-endpoint.test.ts`, `src/cli/commands/bundle.test.ts` | — | An export writes `speed` + `fast`; a `fast`-only legacy file imports as `fast`/`off`; `speed` wins over a conflicting `fast`; an invalid `speed` is refused with a field error; an Ultrafast agent round-trips; the fingerprint changes when the speed changes; the `rebound` reset gives `off` |
| T7 | CLI per §3.1 (flags, usage text, `profile show`), plus `api-client.ts` types (`speed`; harness `profileMcpServers?`; `HarnessStatus.fxProfilePermissionMode?`); the interactive `agetor add` offers the speed tiers from `supportedSpeeds` with discovered model flags when there is more than one | `src/cli/api-client.ts`, `src/cli/commands/add.ts`, `src/cli/commands/manage.ts`, `src/cli/commands/agent-profile.ts`, `src/cli/usage.ts`, `src/cli/test-fixtures.ts`, `src/cli/commands/add.test.ts`, `src/cli/commands/agent-profile.test.ts`, `src/cli/manage.test.ts`, `src/cli/ls.test.ts`, `src/cli/show.test.ts`, `src/cli/commands/pipeline.test.ts`, `src/cli/usage.test.ts` | — | `--speed ultrafast` sends `speed`; `--fast`/`--no-fast` send `speed` fast/off; an invalid `--speed` is a usage error; `--profile` with `--speed` is refused; `profile show` prints `speed: fast`; usage snapshots updated |
| T8 | Launch picker family: the new `SpeedPicker`; `TaskLaunchPickers` state `speed`/`setSpeed`, with `supportedSpeeds` using the selected model option's flags; the profile form, details, clone, issue and resolve-conflicts dialogs send and show `speed`; e2e selectors move to `launch-speed` | `src/mainview/components/kanban/SpeedPicker.tsx` (new), `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/AgentProfileFormDialog.tsx`, `src/mainview/components/kanban/AgentProfileDetailsDialog.tsx`, `src/mainview/components/kanban/CloneProjectDialog.tsx`, `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`, `src/mainview/components/kanban/ResolveConflictsDialog.tsx`, `src/mainview/lib/agent-profile-form.ts`, `e2e/agent-profiles-settings.spec.ts`, `e2e/bundle-export-import.spec.ts` | — (codes against T1 and T10's `api.ts`) | Typecheck green; the cursor fast-capable model shows Off/Fast; the profile details dialog shows "Speed: Fast"; the dirty-tracking setters wrap `setSpeed`; the two specs reference only `launch-speed*` ids |
| T9 | NewTaskForm: speed state, `lastSpeed:<kind>` pref read/write (replacing `lastFast:`), `SpeedPicker` `new-task-speed`, the payload `speed` (a selected profile's `speed` when one is chosen), the §3.1 reset rules | `src/mainview/components/kanban/NewTaskForm.tsx` | — (codes against T1, T8's `SpeedPicker`, T10's `api.ts`) | Typecheck green; no `lastFast` string remains anywhere in `src` (`grep`) |
| T10 | RunPanel task details `SpeedPicker` (`task-speed`; cursor auto-clear kept, fx not auto-cleared, saves `speed`); the agent-switch reset `speed: "off"`; `api.ts` types (`speed`, harness `profileMcpServers?`, `HarnessStatus.fxProfilePermissionMode?`, `updateHarness` accepts `profileMcpServers`) | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/api.ts`, `src/mainview/lib/agent-profiles.test.ts`, `src/mainview/lib/task-context-menu.test.ts` | — | Typecheck green; the profile lock disables `task-speed` exactly like the effort select |
| T11 | Mechanical fixture sweep: in Task/AgentProfile literals only, `fast: false` → `speed: "off"` and `fast: true` → `speed: "fast"`; unrelated `fast` identifiers stay | the 45 files: `src/bun/{approvals-endpoint, claude-followup-restart, claude-session-import, claude-session-launch, claude-subagents-apierror, claude-subagents-bgshell, claude-subagents-chunked-read, claude-subagents-monitor, claude-subagents-yield, claude-subagents.integration, claude-subagents, claude-tmux-death, claude-tmux-stall, claude-turn-routing, claude-workflow-agents, db-checkout-branch, db-events-anchor, db-events-byte-budget, db-events-paging, db-fx-recovery, db-openable, db-run-events-plans, db-sent-files, headless-lag-retention-boot, imported-claude-schema, interactions, message-history, orchestrator-imported-session, pull-create-task-url, reconcile-session, reconcile-subagent-apierror, reconcile, retention, server-blob, server-events-anchor, server-rebuild-byte-budget, server-reveal-path, subagent-settle, subagent-stuck-detection, subagent-toolresult-settle, subagent-watcher-drift, task-events, task-unread, terminals, worktree}.test.ts` | — | Typecheck green; each listed test file passes; diff is fixture lines only (reviewer spot-check); a scripted replace asserts a non-zero count per file (memory: scripted edits silently no-op) |

### Wave 2 — fx and cursor features (no steering)

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| F1 | fx driver per §3.2, except steering: delete the nudge; the `profileMcpServers` meta on all three handshakes; notices capability + the `notice` case; internal/MCP tool metadata; `applyFxSpeed`; the `FX_REVIEW_MODEL` hint; the `yielded` and `cost` comments; the explicit silent `user_message_chunk` case; header facts brought to 0.0.14 (D30: modes `auto`/`ask`/`full-access`, the `set_mode` profile write and why agetor no longer sends it, `currentModeId` now real, profile MCP opt-in, transient failures no longer pause plus the `failed` state, effort/fast/ultrafast options, notices, `toolCall` meta, steering capability (S1 adds the semantics), `AI_AGENT=fx`, the macOS 15+ binaries, the 0.0.13 shell-tool processes dying with the child, `--help` marker unchanged); the fake ACP server in the test moves to 0.0.14 modes | `src/bun/fx-acp.ts`, `src/bun/fx-acp.test.ts`, `src/bun/fx-acp-mapper.test.ts` | Wave 1 | Tests (§5 U-F1): no `session/set_mode` is ever sent, in any mode, on new or resume; the `_meta` is present on new/resume/load when on and absent when off; `initialize` carries `session.notices`; a `notice` maps to the status line; an internal call is stamped on use + result; the MCP name label; the speed matrix (fast/ultrafast/off × present/absent × currentValue, order ultrafast→fast, error breadcrumb, no turn failure); the held line mentions `FX_REVIEW_MODEL`; a `user_message_chunk` with steering meta emits nothing |
| F2 | fx recovery per §3.6 | `src/shared/fx-recovery.ts`, `src/shared/fx-recovery.test.ts` | Wave 1 | `parseFxRecoveryMeta({state:"failed"})` → `failed`; an unknown state → `active`; the summary line for failed; not resumable (failed, `surface_stall`); labels; `latestFxRecoveryByRun` + `latestResumableFxPause` never treat failed as resumable |
| F3 | Discovery and status per §3.4 and D2: `parseFxModels` reading `models[]`; the `model-discovery.ts` signature; `probeStatus` returning `permissionMode` (string or null) from the `status --json` `permission_mode` field, run with `FX_PERMISSION_MODE` **removed** from the probe env, surfaced as `HarnessStatus.fxProfilePermissionMode`; version-truth comments (0.0.14: `--help` marker, the `status --json` field set incl. `permission_mode`/`mode`/`modes`/`effort`/`ultrafast_requested`, the `models --json` 0.0.14 shape with 264 unauthenticated / 145 signed-in ids) | `src/bun/agent-discovery.ts`, `src/bun/agent-status.ts`, `src/bun/model-discovery.ts`, `src/bun/agent-discovery.test.ts`, `src/bun/agent-status.test.ts`, `src/bun/model-discovery.test.ts`, `src/bun/orchestrator-discovered-efforts.test.ts` | Wave 1 | A 0.0.14 envelope gives efforts + `auto`, the `name` label and fast/ultrafast; an ids-only envelope behaves as today; a flag-only change republishes; `permission_mode:"ask"` → `fxProfilePermissionMode:"ask"`; the env-stripping test (the stub records its env); absent field → `null`; fail-open is unchanged; `createTask`'s default effort and the PATCH guard honour fx discovered efforts |
| F4 | `agents.ts` per §3.2/§3.3: cursor `--trust` and `--mode plan` / `--mode ask`; fx spawn passes `speed`, `profileMcpServers: harness.profileMcpServers !== false`; fake-driver seams (§5 seams table) for the fx failed recovery, fx speed unoffered, fx tool meta + notice, and cursor stream (thinking + usage), each driving canned wire events through the real pure mappers (`mapFxUpdate`, `mapCursorEvent`) rather than hand-built chunks; fake cursor honours `plan` in its opening `mode=` breadcrumb | `src/bun/agents.ts`, `src/bun/agents.test.ts` | Wave 1 | Argv: `ask` → `--mode ask --trust`, `plan` → `--mode plan --trust`, `auto` unchanged with no `--trust`; the fx `FxLaunchOptions` carry speed + toggle; each seam works with its marker and is byte-identical without it |
| F5 | cursor mapper per §3.3 (thinking accumulator, usage sentinel, tool-name hardening) plus the version comment (2026.10.22) | `src/bun/cursor-tmux.ts`, `src/bun/cursor-tmux.test.ts` | Wave 1 | P3's captured `out.jsonl` lines (copied into the test as a genericized fixture) → 3 thinking chunks with stable keys `cursor:thinking:<n>`, 1 usage sentinel, tool names `globToolCall`/`readToolCall`; reordered inner keys still give `createPlanToolCall`; a reattach replay from offset 0 produces identical keys |
| F6 | Tool visibility helper + CLI/TUI renderers (§3.6); confirm `failed` sentinels print no progress line | `src/shared/tool-visibility.ts` (new), `src/shared/tool-visibility.test.ts` (new), `src/cli/commands/logs.ts`, `src/cli/logs.test.ts`, `src/cli/tui/Dashboard.tsx`, `src/cli/tui/Dashboard.test.tsx` | Wave 1 | Hidden internal use/result in `logs` and the TUI; MCP labels print as-is; a `failed` sentinel gives no yellow progress line while its summary status line prints |
| F7 | RunPanel features: hide `isHiddenToolEvent` rows from the transcript and from message search; recovery copy reworded (§3.6); the `fx-usage.ts` tooltip goes harness-neutral and `cost` stays optional | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/fx-usage.ts`, `src/mainview/lib/fx-usage.test.ts`, `src/mainview/lib/event-search.ts`, `src/mainview/lib/event-search.test.ts` | Wave 1; F6's helper signature (same wave, pinned in §3.6) | Typecheck green; event-search excludes hidden rows; usage title tests updated |
| F8 | Harness surfaces (D2/D4): Settings → Harnesses fx row gets a "Load profile MCP servers" switch (`harness-profile-mcp-toggle`, PATCH via `api.updateHarness`) and a neutral hint (`harness-fx-ask-hint`) when `status.fxProfilePermissionMode === "ask"`: "fx's own profile starts in Ask mode. Agetor sets each task's mode itself; to change fx's default, run `/permissions` inside fx." CLI `agetor harness add/edit --profile-mcp/--no-profile-mcp`, an `ls` column `profile-mcp` (fx rows: `on`/`off`, others `-`), and the same hint line under the fx row | `src/mainview/components/settings/SettingsDialog.tsx`, `src/cli/commands/harness.ts`, `src/cli/harness.test.ts` | Wave 1 | CLI tests for the flags, the column and the hint; Settings verified by E4 |
| F9 | The cursor plan-approve route per §3.3 (Q1 = a: flip `plan`→`auto` unless profile-bound; embed rule for `ask`/unflipped `plan`) | `src/bun/server.ts`, `src/bun/orchestrator-cursor-plan.test.ts` | Wave 1 | A plan-mode task approves → `mode` becomes `auto` before the message is sent, with the status line; a bound task stays `plan` and gets the warning line plus the embedded plan; an `ask` task is unchanged except for the embed |

### Wave 3 — fx steering (D17/D18, §3.2)

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| S1 | Driver steering: the capability flag, `promptInFlight`, `steer()`, `settlePendingSteers`, `onSteerDropped`, the status line, the header's steering facts (P4); `SpawnedAgent.steer?` | `src/bun/fx-acp.ts`, `src/bun/claude-tmux.ts` (interface field only), `src/bun/fx-acp.test.ts` | Wave 2 | Fake ACP server scenarios: absorbed (the steer RPC carries `_meta.fx.steer: true`, its reply arrives after the main prompt's, no `onSteerDropped`); dropped via −32600 → `onSteerDropped(text)` before `done` resolves, plus the status line; cancelled-dropped (same); never answered within the grace → dropped; unsupported (no capability) → `steer()` returns `false`; >64 KiB → `false`; during the handshake → `false` |
| S2 | Orchestrator steering: `ActiveRun.steer`, the `sendFxTurn` busy branch, `spawnFxRun` → `onSteerDropped` (push into `fxTurnQueue`) | `src/bun/orchestrator.ts`, `src/bun/orchestrator-fx.test.ts` | Wave 2 | Fake-driver integration: steer accepted → one run row, the user event on the active run, the queue empty; dropped → the queued turn spawns after settle; no `steer` → today's queue path |
| S3 | `SpawnAgentArgs.onSteerDropped` passthrough to `spawnFxViaAcp`; the fake fx steer seam (§5) | `src/bun/agents.ts`, `src/bun/agents.test.ts` | Wave 2 | The fake agent exposes `steer` only with the marker; `:absorbed` and `:dropped` behave per the seam table; without the marker it is byte-identical |

### Wave 4 — e2e and docs (parallel)

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| E1–E4 | See §5 | see §5 | Wave 3 | see §5 |
| D1 | Docs (D30, D31, D20, D28, D29): **CLAUDE.md**, i.e. the fx bullet (0.0.14 facts, no nudge, `currentModeId`, profile MCP opt-in + toggle, the recovery story incl. `failed` and never-pausing transient failures, efforts discovery-first, speed tiers, steering, notices, internal/MCP tools, `FX_REVIEW_MODEL`, `deepseek-v4-flash` default and catalog counts 264 unauth / 145 signed-in, compiled default `grok-4.7`, `usage_update` without cost, `yielded`, macOS 15+, per-turn shell processes); the cursor bullet (`--trust`, plan/ask modes, thinking + usage mapping, tool-name rule, verified on 2026.10.22); orchestration item 6 (the `speed` allow-list + `fast` alias); item 15 (profiles: `speed` replaces cursor-only fast); item 20 (bundle `speed` + derived `fast`); the Persistence section (`tasks.speed`/`agent_profiles.speed`, the first `DROP COLUMN`, `harnesses.profile_mcp_servers`); the defaults paragraph. **README.md**: the fx row default model, the macOS 15+ note, the release note for users whose `~/.fx/settings.json` was flipped to `ask` by an earlier agetor (how to reset it with `/permissions` in fx), `FX_REVIEW_MODEL`, the profile-MCP toggle, speed tiers, the cursor modes. Also draft the PR-description release note into this plan's execution record (§8) | `CLAUDE.md`, `README.md`, `docs/plans/fx-0.0.14-and-cursor-updates.md` (execution record only) | Wave 3 | No stale "0.0.10 is the latest" or "no native plan mode" phrasing remains; every new behaviour above is described once |

### Verification stage (after the full suite is green)

| ID | Goal | Notes |
| --- | --- | --- |
| L1 | fx live smoke on 0.0.14 (D8) | `cp ~/.local/bin/fx ~/.local/bin/fx-0.0.10.bak`, then `bash <(curl -fsSL https://fx.sh/setup.sh) v0.0.14`. Check `fx --version` = 0.0.14 and that `fx status --json` `auth` is still `fx login`. Snapshot `~/.fx/settings.json`. In `bun run dev` (`~/.agetor-dev`), on Full access + `deepseek/deepseek-v4-flash`, with ≥25 s between turns: (1) a plain turn; (2) a follow-up sent mid-turn → steered (one run row); (3) an **Ask**-mode task turn → `~/.fx/settings.json` byte-identical afterwards; (4) a `gpt-5.2` task (fast-capable; it is in the owner's catalog) with speed Fast → no breadcrumb, and `deepseek-v4-flash` with Fast → the "isn't offered" breadcrumb; (5) note whether any profile MCP server appears (from `fx status --json` `mcp`). Record the results in §8. If deepseek-v4-flash fails, stop and re-pick the default with the owner (grill assumption 8). |
| L2 | cursor live smoke (D34) | An untrusted scratch dir under the session scratchpad, `--model auto`: a Read-only task (one turn: `--trust --mode ask`), a Plan task whose prompt yields a `createPlanToolCall` (plan card → Approve → the task switches to Auto (force) and the next turn implements it), thinking rendered once per block, the usage chip present. Record the results. |

## 5. Work breakdown — test tasks

Unit and integration tests are owned by, and run with, the implementation task named in "Covers" (same agent, same wave). E2E tasks are their own wave-4 tasks.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U-T1 | unit | T1 | as T1 | see T1 |
| U-T2 | unit (SQL) | T2 | `src/bun/migrate.test.ts` | see T2 |
| U-T3 | unit (db) | T3 | `src/bun/db-speed.test.ts`, `harnesses.test.ts`, `agent-profiles.test.ts` | see T3 |
| U-T4 | integration (HTTP) | T4 | `server-speed-alias.test.ts`, `harnesses-profile-mcp-endpoint.test.ts`, the 3 existing endpoint tests | see T4 |
| U-T5…T7 | unit/integration | T5, T6, T7 | as listed | see the tasks |
| U-T11 | unit (fixtures) | T11 | 45 files | the files compile and pass |
| U-F1 | unit (fake ACP server) | F1 | `fx-acp.test.ts`, `fx-acp-mapper.test.ts` | see F1 |
| U-F2…F9 | unit/integration | F2–F9 | as listed | see the tasks |
| U-S1…S3 | unit/integration | S1–S3 | as listed | see the tasks |
| E1 | e2e | F2, F4, S1–S3, F7 (D33 flow 1) | `e2e/fx-recovery.spec.ts` | (a) a `failed`-marker task: the transcript shows the summary line; no `fx-recovery-notice`, `fx-recovery-resume` or `fx-paused-badge`; the run fails. (b) Steer marker `:absorbed`: a follow-up sent while running → still one run row in the runs list, the user bubble shown, no second run. (c) `:dropped`: the status line "didn't take your message", then a second run answers it. (d) No marker: today's queue behaviour (second run). Existing recovery tests stay green. |
| E2 | e2e | T1, T8–T10, T6, F3, F1/F4 (D33 flow 2) | `e2e/speed-picker.spec.ts` (new), `e2e/fx-models.spec.ts`, `e2e/fx-interactions.spec.ts` | An fx harness whose stub catalog (`AGETOR_E2E_FX_MODELS_JSON`, from E4) has `openai/gpt-6.1-sol` (fast+ultrafast), `openai/gpt-5.2` (fast) and `deepseek/deepseek-v4-flash` (none): the New Task form shows Off/Fast/Ultrafast, Off/Fast and nothing respectively, and the Ultrafast hint mentions cost; the created task's `speed` (via `GET /tasks/:id`) matches; task details edits it; cursor on a fast-capable model shows Off/Fast; an agent profile with Ultrafast round-trips through Settings → Agents and a bundle export → import; the `speed-unoffered` marker breadcrumb. The two existing fx specs are updated for the new default (`deepseek/deepseek-v4-flash` joins the stub's `ids`; count and default assertions adjusted) |
| E3 | e2e | T1, F4, F5, F7, F9 (D33 flow 3) | `e2e/cursor-stream.spec.ts` (new) | Cursor fake driver: New Task Code/Plan toggle on cursor → `task.mode === "plan"` and the opening breadcrumb `mode=plan`; the stream marker renders a thinking block once per block (no per-delta rows) and the run-row usage chip; with `AGETOR_FAKE_CURSOR_PLAN=1` on a plan-mode task, Approve → the task's mode becomes `auto` and the status line appears (Q1 = a) |
| E4 | e2e | F1, F3, F4, F6, F7, F8 (D33 flow 4) + the stub | `e2e/fx-harness-settings.spec.ts` (new), `e2e/fixtures.ts` | Stub: `writeFxStubBin` answers `status --json` with the file at `AGETOR_E2E_FX_STATUS_JSON` and `models --json` with the file at `AGETOR_E2E_FX_MODELS_JSON` **when those env vars are set**, and its default `ids` gain `deepseek/deepseek-v4-flash`; with them unset it behaves exactly as today. The env reaches the probe through the harness env map (the spec creates a second fx harness with `env`), and E4 verifies that path first. The spec: the profile-MCP toggle persists across a reload (`harness-profile-mcp-toggle`); the Ask hint shows for `permission_mode:"ask"` and is absent for `"auto"`; the tool-meta marker → the internal call is not rendered, the MCP call shows "server · tool", the notice status line renders |

**E2E: applies** to the four D33 flows above, because each crosses webview → HTTP API → orchestrator → driver (fake) → SQLite and has user-visible state.

**Run recipe:**
1. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install` (the worktree has no `node_modules`).
2. `bun run typecheck`.
3. Check `uptime`, then `bun test` (if `bun test src/cli` stalls at load >30, kill stale runs and serialize).
4. `bun node_modules/@playwright/test/cli.js test e2e/fx-recovery.spec.ts e2e/speed-picker.spec.ts e2e/cursor-stream.spec.ts e2e/fx-harness-settings.spec.ts e2e/fx-models.spec.ts e2e/fx-interactions.spec.ts e2e/agent-profiles-settings.spec.ts e2e/bundle-export-import.spec.ts`, then the full suite (`bun node_modules/@playwright/test/cli.js test`), with one Playwright process at a time.

The Playwright fixtures start the headless backend per worker with the fake drivers (`AGETOR_FX_DRIVER=fake`, `AGETOR_CURSOR_DRIVER=fake`), the `AGETOR_FX_BIN` stub, a temp `AGETOR_DATA_DIR`, and `E2E_FX_*` timings. No credentials are needed. Specs delete the tasks they create (`afterAll`).

**Fake-driver seams** (F4/S3, `src/bun/agents.ts`, named next to the existing `FAKE_FX_*`):

| Marker / env | Behaviour |
| --- | --- |
| `__agetor_fake_fx_recovery_failed__` / `AGETOR_FAKE_FX_RECOVERY_FAILED=1` | two `active` recovery updates, then a `failed` one (fed through `mapFxUpdate`), then the run fails |
| `__agetor_fake_fx_speed_unoffered__` | emits the §3.2 "Fast/Ultrafast isn't offered" breadcrumb for the task's speed (silent for `off`) |
| `__agetor_fake_fx_tool_meta__` | an internal `capability_search` tool_call + update, an MCP tool_call `{server:"e2e-mcp", tool:"lookup"}` + update, and a `notice` `{severity:"warning", title:"e2e notice"}`, all through `mapFxUpdate` |
| `__agetor_fake_fx_steer__:<absorbed\|dropped>` (+ `AGETOR_FAKE_FX_STEER_HOLD_MS`, default 4000) | the turn holds; the agent exposes `steer()`; `absorbed` → acknowledged by an assistant line; `dropped` → `onSteerDropped(text)` + the status line at settle |
| `__agetor_fake_cursor_stream__` / `AGETOR_FAKE_CURSOR_STREAM=1` | canned P3-shaped NDJSON (2 thinking blocks, a tool call, assistant, `result.usage`) through `mapCursorEvent` |

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 0 | prep: `bun install`; record branch and base SHA in this file | — |
| 1 | T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11 | `bun run typecheck` + `bun test` green (apart from the known pre-existing failures below); `grep -rn "lastFast" src` empty; commit "wave 1: speed enum, fx catalog, storage" |
| 2 | F1, F2, F3, F4, F5, F6, F7, F8, F9 | typecheck + `bun test` green; commit "wave 2: fx 0.0.14 + cursor features" |
| 3 | S1, S2, S3 | typecheck + `bun test` green; commit "wave 3: fx steering" |
| 4 | E1, E2, E3, E4, D1 | typecheck + targeted Playwright specs (recipe step 4) green, then the full `bun test` + full Playwright run (test-loop, up to 3 fix rounds); commit "wave 4: e2e + docs" |
| 5 | L1, L2 (live; the owner's machine) | results recorded in §8; any fix goes through a mini-wave and re-runs the affected suites |

**Known pre-existing failures** (memory, last re-confirmed 2026-09-30): tmux-socket ×2 and one reconcile-cancel test. Report them, don't fix them; any *other* red test blocks the barrier.

**Ownership validation** (each path appears in exactly one task per wave):

- **Wave 1**:
  - `src/bun/agents.ts`, `orchestrator.ts` and `pipeline-runner.ts` are T5 only.
  - `server.ts` is T4 only and `db.ts` T3 only.
  - `RunPanel.tsx` and `api.ts` are T10 only.
  - `bundle.test.ts` (the CLI copy) is T6, not T7.
  - `orchestrator-fx.test.ts` is T5 and not in T11's list.
  - The two e2e specs are T8 only.
  - The T11 list was computed by excluding every file owned by T1–T10.
- **Wave 2**:
  - `agents.ts` is F4 only and `fx-acp.ts` F1 only.
  - `RunPanel.tsx` is F7 only and `server.ts` F9 only.
  - `cursor-tmux.ts` is F5 only.
  - `SettingsDialog.tsx` and `harness.ts` are F8 only.
  - The `src/shared` files split as F2 (`fx-recovery`) and F6 (`tool-visibility`).
- **Wave 3**: `fx-acp.ts` + `claude-tmux.ts` are S1, `orchestrator.ts` S2, `agents.ts` S3.
- **Wave 4**: `e2e/fixtures.ts` is E4 only. The two existing fx specs are E2 only. Docs are D1 only.

**Same-wave interface pins**:

- Wave 1: T8–T10 use T1's `Speed`, `supportedSpeeds` and `SPEED_OPTIONS`, plus `SpeedPicker`'s props (§3.1). T3/T4/T5 use T1's types and T2's column names.
- Wave 2: F7 uses F6's `isHiddenToolEvent(stream, data)`. F4 uses F1's `FxLaunchOptions.speed` and `.profileMcpServers`.
- Wave 3: S2/S3 use S1's `steer` and `onSteerDropped` signatures.

## 7. Blast radius & risks

- **The speed enum is a breaking internal change across about 64 source and 71 test files** (G3). Every barrier is typechecked, the aliases keep older CLIs and webviews working against a new core, and the `.fast` acceptance grep (§3.1) catches stray reads. The risk is a missed write path that silently drops a cursor Fast toggle; T4's alias tests and E2's round trips cover it.
- **DROP COLUMN, one-way door 1.** After 072, an older agetor build reads every task as not fast; a downgrade loses cursor Fast flags (owner-accepted, D14). The rollback is a new migration that re-adds `fast` from `speed`; the column can never be "un-dropped" by editing 072.
- **Retirement, one-way door 2.** 074 rewrites 3 model ids on fx-kind rows only, which is a no-op on the owner's prod. Frozen snapshots keep the old ids by house rule; a snapshot-bound task whose model was retired then runs an id the Gateway no longer has, and fx reports the error (accepted, same as 066).
- **Mixed fx versions (0.0.4–0.0.14).** The nudge removal is safe everywhere (G1). The meta is harmless on 0.0.10 (P1); on ≤0.0.9 it is unverified, but `_meta` is extension space and ACP servers ignore unknown `_meta`. Notices are ignored by older fx, which keeps the `[context]` fallback. Speed options are absent on ≤0.0.12 (silent for `off`, a breadcrumb otherwise). Steering is runtime-detected. Discovery falls back to `ids`.
- **Steering semantics.** A steer fx turns into its own next turn is killed and re-queued (§3.2 accepted risk). The 2 s grace adds up to 2 s to a turn's settle **only** when a steer is pending. If a fake or real server never answers, the grace bounds the wait.
- **Security posture.** `--trust` (one-way door 4) records workspace trust per worktree, so a worktree's `.cursor` rules and hooks apply in Read-only/Plan, as they already do in Auto via `--force`. The profile-MCP opt-in loads the user's own fx profile servers, matching fx in a terminal. Both are owner-decided (D3, D22).
- **Recovery.** A turn on 0.0.14 can keep retrying for a long time; a pipeline step waiting on it stays `running` (owner-accepted, grill assumption 9). `failed` is now terminal and shown as such.
- **Cursor `plan` mode** is a new mode id. Older agetor builds treat it as an unknown passthrough (no `--force`, no `--trust` → fails untrusted). Rollback: change the mode back to Read-only or Auto.
- **The e2e stub change** (E4) touches a worker-wide fixture. The env-gated behaviour keeps every other spec's stub output identical apart from the added `deepseek/deepseek-v4-flash` id, and E2 owns the two specs that assert the catalog.
- **Blast-radius checks per task:** `grep` for each changed export's callers (memory: grep client method names in `api.ts` + `api-client.ts`, not route strings). Use the Grep tool or `grep -a` for `.tsx` files, since BSD grep treats `PromptComposer.tsx` as binary. Avoid zsh globs in inventory greps (memory: `nomatch` voids the command).

## 8. Open questions / assumptions

**Q1 (resolved by the owner at plan approval, 2026-10-22):** when a cursor task in the new `plan` mode has its plan approved, agetor **switches the task to Auto (force)** so cursor can implement it. A profile-bound task keeps Plan and gets a warning (§3.3, F9, E3).

**Plan-approval addition (owner, 2026-10-22):** migration 074 also moves the `lastModel:fx = zai/glm-5.3-flash` **pref** to `deepseek/deepseek-v4-flash`. The owner's 2 prod fx tasks on glm-5.3-flash are not touched, since the model is not retired (§3.5).

**Assumptions proceeding:**

1. `zai/glm-5.3-flash` stays a curated fx row. It is in the 0.0.14 unauthenticated catalog; the catalog-scoped picker hides it on accounts that lack it.
2. `_meta.fx.profileMcpServers` is harmless on fx ≤0.0.9 (verified on 0.0.10 and 0.0.14 only; see §7).
3. Grill assumptions 1–3, 5 and 8 stand as recorded. Assumptions 4, 6 and 7 are **closed** by P1, P3 and P2.
4. The fx speed options persist on a session across `session/resume`; the driver reconciles on every turn either way, so correctness does not depend on this.
5. `deepseek/deepseek-v4-flash` runs on the owner's account on 0.0.14; L1 confirms it, and if it fails the owner re-picks.

**Execution record** (filled in during the run): branch/base SHA, per-wave commit SHAs, L1/L2 results, and D1's draft PR release note.

- **Branch / base:** `feature/fx-and-cursor-updates`, cut from `fbd68603afef778a618a94ca88e0c00997956afd`.
- **Commits so far:** `1daf1834` docs (plan, investigation, grill) · `0ed6a082` wave 1 prep (the speed contract) · `b07caf56` wave 1 (speed enum, fx catalog, storage) · `f0e97539` wave 2 (fx 0.0.14 + cursor features). · `36b6f03` wave 3 (fx steering + docs) · `125a478` docs (steer send order) · `784ea8a` wave 4 (e2e).
- **Verification at hand-off:** `bun run typecheck` clean; full `bun test` green at wave 2 (8512 pass / 0 fail) and at wave 3 apart from 9 TUI/endpoint timing failures under load 40–90 that pass file-by-file; the 8 targeted Playwright specs green together (101 tests); full Playwright 337 pass / 2 load flakes (`font-size.spec.ts:294`, `theme.spec.ts:138`, both green on rerun).
- **Deviations recorded during execution:** a built-in harness accepts a `profileMcpServers`-only patch; a non-boolean `fast` (and `speed`/`fast: null`) now 400s instead of coercing; RunPanel's usage chip was fx-gated and now also scans cursor; fx's paused summary reads " — fx paused this response; resume it, or send a new message."; a failed fx lane-off reads "fx: couldn't turn off <Tier> — <msg>"; the plan-approve mode switch happens after the plan file is written and is reverted when the send isn't delivered; the bound-task warning is also a PlanDialog toast; the held-tool line points at an added fx harness's env for `FX_REVIEW_MODEL` (built-in env is fixed); dropped steers re-queue in send order (`fxSendSeq`); the e2e worker backends now run the fake cursor driver.
- **L1 / L2 results:** not run — L1 upgrades the owner's `~/.local/bin/fx` to 0.0.14 and needs the owner's go-ahead; both run against `~/.agetor-dev` only.
- **Draft PR release note (D31, for the PR description):**

  > **fx 0.0.14 and cursor-agent 2026.10 support**
  >
  > - **fx 0.0.14.** Agetor now supports fx up to 0.0.14 and still works with older versions back to 0.0.4. The fx 0.0.14 release binaries need macOS 15 or later.
  > - **Agetor no longer changes your own fx profile.** Earlier Agetor versions sent fx a mode switch at the start of each Auto or Ask turn, and fx 0.0.14 saves that switch into `~/.fx/settings.json`, so your interactive fx may now start in Ask. Agetor no longer sends it. To reset your profile, run `/permissions` inside fx. Settings → Harnesses and `agetor harness ls` show a hint while your fx profile starts in Ask.
  > - **Profile MCP servers.** fx 0.0.13 and later load your own fx profile's MCP servers only when asked to, and Agetor now asks by default. Turn it off per harness with **Load profile MCP servers** in Settings → Harnesses, or `agetor harness edit <id> --no-profile-mcp`.
  > - **Speed tiers.** The cursor-only Fast switch is now a **Speed** control (*Off*, *Fast*, *Ultrafast*) for every harness, shown when the model offers more than Off: Cursor's Fast variants, and fx's AI Gateway fast lanes as your account's catalog reports them. Ultrafast costs more per token than Fast. The CLI takes `--speed off|fast|ultrafast`, and `--fast`/`--no-fast` still work.
  > - **Messages during an fx turn.** With fx 0.0.13 or later, a message sent while fx is working joins the running turn. If fx doesn't take it before the turn ends, Agetor sends it as the next turn.
  > - **Clearer fx transcripts.** fx's own internal tool calls are hidden, MCP tool calls are labelled *server · tool*, fx notices show as status lines, and a response fx stops retrying is shown as failed rather than as an endless retry. The "fx held this tool call" line now also points at `FX_REVIEW_MODEL` for choosing a reviewer model your account can reach.
  > - **Cursor Plan and Read-only modes.** Cursor gains a real *Plan* mode (`--mode plan`), used by the Code/Plan toggle; approving its plan switches the task to *Auto (force)* to implement it, unless the task runs from an Agent. *Read-only* now runs `--mode ask`. Both pass `--trust`, so `cursor-agent` accepts each task's fresh worktree. Cursor thinking renders as one block per thought, and the run row shows Cursor's token usage.
  > - **New default fx model.** New fx tasks default to DeepSeek V4 Flash, since GLM 5.3 Flash isn't in every account's catalog.
  > - **Retired fx models migrated.** Tasks and Agents on Qwen3 Coder Plus, Devstral 2 or Claude 3 Haiku move to DeepSeek V4 Flash.
  > - **Downgrade note.** This release replaces the `fast` columns with `speed` (migration 072). If you go back to an older Agetor build afterwards, it reads every task and Agent as not fast.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Every `fast` producer/consumer in `src` (types, db, routes, orchestrator, agents, pipeline runner, bundle, CLI, webview) | In this run | T1, T3–T10 |
| 71 test/spec files with `fast` fixtures | In this run | T1–T8, T10 (owned), T11 (45 files) |
| Existing `tasks.fast` / `agent_profiles.fast` rows; `lastFast:*` prefs | In this run | T2 (072) |
| Stored JSON with `fast` (task snapshots, pipeline-run snapshot profiles, bundle files) | In this run | T3 (lenient parse), T6 (bundle reader) |
| API/CLI `fast` alias + derived `fast` in responses | In this run | T3, T4, T7 |
| Bundle fingerprint and rebind reset carrying `speed` | In this run | T6 |
| `harnesses.profile_mcp_servers` column and every surface (db, routes, api types, Settings, CLI, driver, spawn) | In this run | T2, T3, T4, T7, T10, F8, F1, F4 |
| Retired fx ids in `tasks.model`, `agent_profiles.model`, `lastModel:fx` | In this run | T2 (074), T1 (tables) |
| Retired ids inside frozen snapshots | Not rewritten | house rule (066); accepted in §7 |
| `lastModel:fx = zai/glm-5.3-flash` pref | In this run | T2 (074, pref only; owner at plan approval) |
| `tasks`/`agent_profiles` rows on `zai/glm-5.3-flash` | Not migrated | owner at plan approval: the model is not retired |
| `acpModeIdFor`, the nudge, the header `code`-registry text | In this run | F1 |
| Users' `~/.fx/settings.json` already flipped to `ask` | In this run: hint + release note; no repair | F3, F8, D1 (owner: D1, D2, D31) |
| Fake ACP server's 0.0.10 modes | In this run | F1 |
| `failed` recovery state: parser, summary, RunPanel, logs, TUI, auto-resume gate | In this run | F2, F1 (verify), F7, F6 |
| New causes/actions/required action labels | In this run | F2 |
| fx efforts discovery-first + curated refresh + discovered labels + change signature | In this run | F3, T1 |
| fx speed tiers: discovery flags, pickers, driver, fake seam, CLI | In this run | F3, T8–T10, F1, F4, T7 |
| Speed tiers for claude-code/codex/gemini/antigravity | Out of scope | owner (D12): enum gives them `off` only; a different feature |
| Steering + replay dedupe + fallback queue | In this run | S1–S3, F1 |
| Notices, internal tool hiding (webview, CLI, TUI, search), MCP labels | In this run | F1, F6, F7 |
| `FX_REVIEW_MODEL` hint + docs | In this run | F1, D1 |
| Dedicated `FX_REVIEW_MODEL` Settings field | Declined | owner (D20) |
| Profile instructions as an ACP system prompt | Declined | owner (D19) |
| Agetor-side recovery cap / time-based nudge | Declined | owner (D5) |
| `stopReason: "yielded"`, `usage_update` without `cost`, macOS 15+ | In this run: comments/docs | F1, F7, D1 (owner: D29) |
| fx shell-tool processes dying per turn (0.0.13+) | In this run: docs only | D1 (owner: D28) |
| Keeping the fx child alive across turns | Out of scope | owner (D28): architecture change |
| Cursor `--trust`, `plan` mode, `--mode ask`, labels | In this run | T1, F4 |
| Cursor plan approval under `plan` mode | In this run | F9 (owner: Q1 = switch to Auto) |
| Cursor thinking, usage chip, tool-name hardening (`detectCursorPlan` robustness) | In this run | F5, F7 |
| `--approve-mcps` | Not needed | P3: plan/ask with `--trust` ran with no MCP stall |
| Cursor SDK / `agent acp` migration | Out of scope | owner (D26): separate ticket |
| Curating `muse-*` cursor rows, new fx ids (`deepseek-v4.1-flash-1017`, …) | Out of scope | owner (D27): discovery surfaces them |
| fx `--sessions-v2`, cursor `--auto-review`/`--add-dir`/`--plugin-dir`/`agent persist`, fx `--ultrafast` argv flag, `status --json` `effort`/`ultrafast_requested` | Out of scope | not needed by current behaviour (grill dispositions; §3 alternatives) |
| Docs: CLAUDE.md (fx, cursor, items 6/15/20, Persistence, defaults), README, fx-acp header, discovery/status comments | In this run | D1, F1, S1, F3, F5 |
| `docs/plans/fx-0.0.10-compat.md` | Left as history | owner (D30) |
| Release note in the PR description | In this run: drafted by D1 into §8; posted by the commit/PR pipeline step | D1 (owner: D31) |
| Existing fx e2e specs assuming the old default / 3-id stub | In this run | E2, E4 |
| e2e for the four D33 flows | In this run | E1–E4 |
| Live smokes + fx binary backup/upgrade | In this run | L1, L2 (owner: D8, D34) |
| Cursor-agent version truth (2026.10.22, auto-updated mid-pipeline) | In this run | F5, D1 |
