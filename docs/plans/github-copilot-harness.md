# Plan — GitHub Copilot CLI harness

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | Pipeline goal "Add Github Copilot Harness"; `docs/plans/github-copilot-harness-investigation.md` (step 1); `docs/plans/github-copilot-harness-grill.md` (step 2, decisions D1–D27); a read-only re-grounding pass on `c5cf1a2` (this step) |
| Flags | none |
| Gates | grilled + approved by owner (2026-10-27, pipeline step 3 — "Approve as written", including the §8 planner choices A1–A12) |
| Branch | `feature/add-github-copilot-harness` (already checked out in this worktree) |
| Base SHA | `c5cf1a2d431f2891506a26010695289a1b6c46ae` (execution started 2026-10-27; tree clean apart from the three untracked plan docs) |

---

## 1. Objective & success criteria

Ship GitHub Copilot CLI (`copilot`, cask `copilot-cli` / npm `@github/copilot`) as agetor's seventh `AgentKind`, `copilot`, labelled **"GitHub Copilot"**. It gets the same level of support as the other one-shot tmux kinds, plus the parity features the owner put in v1.

Done means:

1. **Settings.** A fresh or upgraded database has a built-in `copilot` harness, **enabled**, with the Experimental badge (D2). Settings, Onboarding, `agetor harness ls` and the pickers show it. When `copilot` isn't installed it reads "not installed" with `brew install --cask copilot-cli`. A binary that isn't GitHub's (AWS Copilot) is refused by name (D17).
2. **Launch.** A task launched on it runs `copilot --output-format json --session-id <uuid> …` inside a per-task tmux session, with the prompt on stdin. The transcript streams assistant text, thinking, tool calls and results. The run settles `succeeded`/`failed`/`cancelled` correctly: a Stop is `cancelled` even though Copilot exits 0 (D21). Only `result` or process exit ends a run.
3. **Restarts.** A turn in flight survives an agetor restart (boot reconcile reattaches). A restart between turns needs nothing.
4. **Follow-ups.** A message sent mid-turn queues and runs as the next turn (D24). It resumes the same Copilot session **only on the same harness id**; after a harness/account switch it starts fresh and says so (D14).
5. **Modes, model and effort.**
   - Modes: Auto (`--allow-all` + `COPILOT_ALLOW_ALL=true`, worktree trusted), Plan (`--mode plan`) and Read-only (no allow flags; the copy says edits are denied and the run can still report success). `--mode` is passed on every turn (D4, D6, D21, D22).
   - Default model `auto`. With `auto`, a status line names the model Copilot actually used (D3, D23).
   - Per-model effort with a "Model default" row; the default is `auto`, which omits `--reasoning-effort` (D7).
6. **Plan card.** A Plan-mode turn that produces a plan shows a plan card. Edit + Approve sends an "implement" message. An unbound task flips to Auto; a profile-bound task keeps Plan, gets the plan embedded, and the response carries a warning. Double-approve is blocked (D5).
7. **Parity features.**
   - Thinking stream (D11a).
   - Run-row usage chip with tokens, plus AI credits only once verified (D11b).
   - Copilot skills / MCP servers / custom agents appear in `/` autocomplete and the Extensions picker, including at a git ref (D11c).
   - Too-old CLIs are refused per model (D11d).
   - Copilot subagents render as background-agent tabs (D12).
   - An "Additional GitHub Copilot" harness template isolates a second account via `COPILOT_HOME` (D12).
8. **Status lines.**
   - A run that fails for lack of login says to run `copilot login` (D8).
   - Compaction, `session.error`, `session.warning` and retry notices become status lines (D24).
   - A classic `ghp_` value in `GH_TOKEN`/`GITHUB_TOKEN` never reaches Copilot unless the harness env sets it (D10).
9. **No silent fallthrough.** `buildCommand`, `spawnAgent` and the `onSessionId` → column mapping throw on an unknown kind. `harnessEnv` is compile-time exhaustive (see §8 A1 for the one deviation). A future kind fails typecheck instead of launching codex (D13).
10. **Bar (D15).**
    - `bun run typecheck` is green.
    - `bun test` is green, apart from the three known pre-existing failures.
    - A real-binary BYOK integration test passes locally.
    - The Copilot Playwright spec and the full e2e suite are green.
    - A live smoke per mode on the owner's real login passes, or its absence is reported plainly.

## 2. Context & constraints

All anchors are on `c5cf1a2` (this branch); several moved a few lines from the investigation's.

**Shared types — `src/shared/types.ts`.**
- `AgentKind` `:296`; `Harness.home` doc `:311-335`; `HARNESS_TEMPLATES` `:985` (no antigravity entry); `USAGE_SUPPORTED_KINDS` `:1829` (untouched — deferred).
- `AgentOption`/`AgentOptions` `:2458/2481`; `DEFAULT_MODEL` `:2511`; `CATALOG_SCOPED_KINDS` `:2583` (fx only, untouched); `DEFAULT_EFFORT` `:2584`; `MODEL_MIN_CLI_VERSION` `:2638`; `CODE_PLAN_MODE` `:3099`.
- `EFFORT_OPTIONS` `:3154`: the `auto` "Model default" row `:3163` is documented fx-only.
- `MODEL_EFFORT_SUPPORT` `:3186`.
- `supportedEfforts` `:3467`: drops `auto` from a discovered set for every kind but fx (`:3487`).
- `MODEL_MODE_DENY` `:3537`; `defaultModeFor` `:3593`; `AGENT_OPTIONS` `:3597` (antigravity `:3843`); `Run` `:3887` (`antigravitySessionId?` optional `:3951`).
- `FX_USAGE_STATUS_PREFIX` `:67` + `FxUsagePayload` `:80`, already harness-neutral (cursor reuses them).
- `SESSION_DIED_STATUS_PREFIX` `:18`; `SubagentStatus` `:4810`; `Subagent` `:4831`.

**Agent dispatch — `src/bun/agents.ts`.**
- `resolveBin` `:300`: a switch with no default.
- `harnessEnv` `:340`: its final `else` sets `GEMINI_CLI_HOME`.
- `buildHarnessTerminalCommand` `:427`.
- `buildCommand` `:479`: the antigravity branch `:726` is the template; trailing code is the codex branch.
- `spawnAgent` `:3123`: per-kind branches and fake seams; it falls through to codex `:3288`.
- `SpawnAgentArgs` `:3044` (`onChunk`, `onSessionId`, `onSteerDropped`, `opts`).
- `pinClaudeConfigDir` (`claude-tmux.ts:586`) is the precedent for "the long-lived tmux server's env may belong to another process — pin or unset per spawn".

**Driver templates.**
- `src/bun/antigravity-tmux.ts` (548 lines): per-run paths `:46-59`; `mapAntigravityEvent` `:144`; tailer `:339`; `spawnAntigravityViaTmux` `:426` (the `sh -c '"$@" … > log 2>&1; echo $? > exit'` wrapper); `reattach…` `:506`; `…SessionActive` `:537`; `drop…` `:541`.
- `codex-tmux.ts` is the `< promptfile` stdin sibling.
- `gemini-tmux.ts` is the self-issued session-id sibling.

**Orchestrator — `src/bun/orchestrator.ts`.**
- Driver imports `:117`.
- `reconcileOrphans` SELECT and reattach chain `:797-900` (key ternary `:826`, kind gate `:840`, reattach call `:892`).
- `startTask` spawn args with the `onSessionId` ternary `:1790-1801`: the fx default arm is the fallthrough.
- `detectCursorPlan` `:2480`, called from `attachDoneHandler` `:2604`.
- Queue drains `:2679-2686`.
- Agent-switch drop + queue clear `:2763-2777`.
- `sendInput`'s early CLI-floor gate is codex-only `:3591-3597`; per-kind dispatch `:3747`.
- `minCliVersionError` `:3875`.
- codex follow-up turn with floor re-check `:3928-3940` (the model to copy for queue/floor semantics).
- antigravity turn queue `:4448-4598` (the model to copy for session-id handling).
- Archive drop `:6826`; delete queue clear and drop `:7173/7198`.
- `setSubagentEmitter(emit)`/`setSubagentSettleHook(maybeReleaseHeldTask)` `:359-365`: the SSE emitter subagent events use.

**Persistence.**
- `src/bun/db.ts`: `toHarness` `:1716` passes retired kinds (`grok`/`kimi`) through as-is; `getByIdOrKind` `:1806`; `harnesses.insert` kind whitelist `:1836`; runs session-id columns `:2571/2666/2710/2722`; `runs.appendEvent(runId, stream, data, lineUuid, subagentId)` `:3158`; `subagents` module `:3444` (`insertIfAbsent`, `setStatus`, `hasRunning`, `orphanRunning`).
- Migrations:
  - `061_antigravity_harness.sql` is the rebuild recipe.
  - `073_harness_profile_mcp_servers.sql` added `profile_mcp_servers` after it.
  - No table has an FK to `harnesses(id)` (comment in `032`, `043`, `052`), so a DROP/RENAME rebuild is safe.
  - `migrations/index.ts` keeps `aliases` for renumbered ids; `migrate.ts:101` back-fills a canonical id from an alias.
  - `migrate.test.ts:1151` pins "074 is the last registered migration".

**Status and discovery.**
- `src/bun/agent-status.ts`: `INSTALL_HINTS` `:17`; `BREW_PACKAGES` `:32`; `upgradeHintFor` `:79` (`brew upgrade <pkg>` — no `--cask`); `probeVersion` `:89`; `FX_HELP_MARKER` `:414`; `checkHarness` `:475` (fx wrong-binary pattern `:532-560`).
- `harnessEnv` is called for every harness at `:522`, so a throw there would break `GET /harnesses` for a retired-kind row.
- `src/bun/agent-discovery.ts`: `parseAntigravityModels` `:469`; `discoverAntigravity` `:492`; `runRefresh` with its index-aligned `kinds` array `:961-985`; `runRefreshKind` switch `:1112-1131`.

**Server — `src/bun/server.ts`.**
- `planCursorKindGuard` `:546`; plan PATCH `:6806` and approve `:6868` routes (approve writes `.cursor/plans/…`, flips Plan→Auto, `boundPlanWarning`, `approvalsInFlight`).
- `POST /harnesses` kind whitelist and error copy `:3930-3937`.
- `/agent-models` maps `:4905/4940`.
- `src/bun/task-plans.ts`: `upsertDetectedPlan` `:103`; `approvePlan(…, { filePath: string })` `:166`.

**Capability discovery.**
- `src/bun/commands.ts`:
  - `AvailableCommand`/`AvailableExtension` `:25/44` (extension kinds `mcp|skill|plugin`).
  - `CAPABILITY_READ_PATTERNS` `:210`; `homeForHomeKinds` `:238`.
  - Per-kind skills walk `:324-380`: gemini/antigravity fall through to nothing.
  - Per-kind MCP parse `:710-760`; collapse order `{mcp, skill, plugin}` `:781`.
- `src/bun/ref-tree.ts:300` `DEFAULT_PATHSPECS` has no `.github`.
- `src/bun/bundle.ts:313` `userLevelSkills` is gated to claude-code/codex/cursor/fx.

**Webview.**
- `App.tsx:246` and `TaskLaunchPickers.tsx:185` `AgentModelMap` literals.
- `NewTaskForm.tsx:307-312` (per-kind seed), `:371`, `:993` (Plan-button title chain).
- `RunPanel.tsx`: usage gating `:1807` (fx/cursor); plans gating `:4157` (cursor/claude); `PlanCard` substitution keyed on the `tool_use` id `:5549-5556`.
- `PlanDialog.tsx:111` (`editable` = cursor ∧ pending).
- `AgentIcon.tsx:8-21` (`@lobehub/icons` has `GithubCopilot`, Mono only).
- `SettingsDialog.tsx`: `isExperimentalKind` `:145`, `HARNESS_HOME_COPY` `:182-209`, kind list `:1908`.
- `OnboardingChecklist.tsx:44`; `lib/api.ts:200` (extension kind) and `:214` (`AgentModelMap`).
- `ExtensionPicker.tsx:38-42` (`KINDS`).
- `lib/fx-usage.ts` (parse/merge/chip).
- `lib/subagent-tabs.ts:20-48`: tabs are kind-agnostic and driven by `subagents` rows.

**CLI.** `src/cli/commands/harness.ts:140` login hint (claude/cursor, generic fallback). Pickers read `AGENT_OPTIONS`.

**Tests that iterate every kind** (Copilot joins them automatically and must satisfy them): `src/shared/types.test.ts:84`, `src/bun/agents.test.ts:2580`, `src/bun/agent-profiles.test.ts:444`. The plan-guard copy isn't pinned by any test.

**Copilot facts (spike-verified, 1.0.104, BYOK; investigation §2).**
- JSONL is flushed per event. `--session-id <uuid>` creates *or* resumes. Stdin prompt delivery works.
- `result` is terminal. `assistant.turn_end` fires per model sub-turn.
- SIGINT/SIGTERM produce `abort` + `assistant.idle{aborted}` + `result.exitCode 0`, rc 0.
- Provider failure: retries, then `session.error`, then rc 1. Unauthenticated: rc 1 with a plain-text stderr "Error: No authentication information found." and empty stdout.
- Without allow flags, mutations are silently denied (rc 0).
- `--mode plan` is sticky across resumes; `--mode interactive` exits it. Plan mode writes `$COPILOT_HOME/session-state/<id>/plan.md`.
- `COPILOT_ALLOW_ALL=true` (exact value) trusts the folder and works with `--session-id`. `--trust-folder` refuses `--session-id`.
- `--usage-output-file` gives per-model token metrics, `totalNanoAiu` and `aiCreditsStatus`.
- `copilot help config` lists 31 model ids offline: the `model` block, lines `    - "<id>"`.
- `copilot --version` prints `GitHub Copilot CLI 1.0.104.`; `parseCliVersion` extracts `1.0.104`.

**Event schema (bundled `schemas/session-events.schema.json`, read this step).**

| Event | Required fields | Optional fields |
| --- | --- | --- |
| `assistant.message` | `messageId`, `content` | `model`, `toolRequests`, `reasoningText`, `parentToolCallId` |
| `assistant.reasoning` | `reasoningId`, `content` | — |
| `tool.execution_start` | `toolCallId`, `toolName` | `arguments`, `mcpServerName`, `mcpToolName`, `parentToolCallId` |
| `tool.execution_complete` | `toolCallId`, `success` | `result`, `error`, `parentToolCallId` |
| `subagent.started` | `toolCallId`, `agentName`, `agentDisplayName`, `agentDescription` | `agentType` |
| `subagent.completed` | `toolCallId`, `agentName`, `agentDisplayName` | `cancelled` |
| `subagent.failed` | `toolCallId`, `agentName`, `agentDisplayName`, `error` | — |
| `exit_plan_mode.requested` (**ephemeral**) | `requestId`, `summary`, `planContent`, `actions`, `recommendedAction` | — |
| `session.error` | `errorType`, `message` | `remediation`, `statusCode` |
| `session.warning` | `warningType`, `message` | — |

**Changelog-derived floors** (first stable version mentioning the model):

| Model | First version |
| --- | --- |
| `kimi-k3` | 1.0.79 |
| `claude-fable-5.1` | 1.0.83 |
| `gpt-6-astra` | 1.0.85 |
| `claude-opus-5.5`, `gpt-6-sol`, `gpt-6-luna` | 1.0.89 |
| `gpt-6.1-sol` | 1.0.90 |
| `claude-haiku-5.5` | 1.0.94 |
| `gemini-4-argon` | 1.0.98 |

No match was found for claude-sonnet-5.5, gemini-3.8-flash, grok-4.7 or mai-code-1.1-flash, so those get no floor (fail-open).

**Concurrent branches.**
- `feature/add-gpt-6-1-terra` already commits migrations `075_retire_codex_gpt_5_5` and `076_normalize_cursor_new_families` (unmerged).
- `feature/add-opencode-harness` has no commits yet. It plans its own harnesses rebuild (KB decision `a1a98166`: union CHECK, `INSERT OR IGNORE`, the second to merge renumbers with `aliases`).
- It also lands the owner rule "built-ins auto-enable once when their CLI is first detected" (KB `9f11635f`). That is a no-op for Copilot, which is seeded enabled like claude-code/antigravity.

**Constraints.**
- Dogfooding with `bun run dev` must use `~/.agetor-dev`, never `~/.agetor`.
- The `agetor` CLI always talks to the running prod core. Smoke it only with `--help` or a fresh `--data-dir`.
- The worktree has no `node_modules`. Run `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun install` first.
- Never commit real account/token/org names. Use synthetic fixtures; harness ids like `copilot-2`.

## 3. Approach & key decisions

Every decision below rests on the grill (owner) or on evidence. Ones marked *(planner)* were made in this step on reasoning and are flagged in §8.

### 3.1 Driver — `src/bun/copilot-tmux.ts` (D1)

A one-shot-per-turn tmux driver cloned from `antigravity-tmux.ts`, with codex's stdin delivery and gemini's self-issued session id.

**Argv** (built by `buildCommand`, last element before the shell wrapper):

```
<bin> --output-format json --no-color --no-ask-user
      --session-id <uuid>
      --model <model>
      [--reasoning-effort <effort>]         # omitted when effort is null or "auto"
      --mode <interactive|plan>             # always passed: plan for Plan, else interactive (D21)
      [--allow-all]                         # Auto only (D4)
      --usage-output-file <dataDir>/copilot-logs/<runId>.usage.json
      [...AGETOR_COPILOT_ARGS]
```

**Env** (from `buildCommand`, layered over `harnessEnv`):
- `COPILOT_HOME` is **always pinned** to `copilotHome(harness)`. *(planner)* The tmux server's env may belong to another process, and the plan-file reader must look in the same dir Copilot writes to. This is the `pinClaudeConfigDir` precedent.
- `COPILOT_ALLOW_ALL=true` is set in Auto only, unless the harness env map sets it.

**Shell wrapper** (`buildCopilotShellCommand`, exported and pure, so it can be unit-tested):

```
sh -c '<guards> "$@" < <prompt> > <log> 2>&1; echo $? > <exit>' sh <argv…>
```

- `<guards>` is, for each variable named in `stripClassicTokens` (from `buildCommand`: `GH_TOKEN`/`GITHUB_TOKEN` minus any the harness env sets), `case "${V-}" in ghp_*) unset V;; esac;`. This is D10, evaluated against the **pane's real env** rather than agetor's process env.
- In Plan and Read-only modes the wrapper also `unset COPILOT_ALLOW_ALL` unless the harness env sets it. *(planner)* Otherwise an ambient export would silently turn Read-only into allow-all.
- Paths are single-quoted with the driver's `sq()`. Variable names are constants.

**Tailer.** Same as antigravity: `fs.watch` + 150 ms poll + death probe, emitting `SESSION_DIED_STATUS_PREFIX`. Reading from offset 0 is idempotent, because each event's own `id` (uuid) is the `line_uuid` (`copilot:<id>`).

**Mapper** (`mapCopilotEvent(line, lineIndex, ctx)`, pure):

| Input | Output |
| --- | --- |
| `assistant.message` with non-empty `content` | `assistant`. If no `assistant.reasoning` arrived for that turn and `reasoningText` is non-empty, emit a `thinking` chunk first (the fallback for D11a). |
| `assistant.reasoning` | `thinking` |
| `tool.execution_start` | `tool_use` `{id: toolCallId, name: mcpServerName ? "<server> · <mcpToolName>" : toolName, input: arguments}` |
| `tool.execution_complete` | `tool_result` `{toolUseId, content: result.content ?? error.message, isError: !success}` |
| Any event with `parentToolCallId` | Routed to the **subagent sink** (`event(parentToolCallId, stream, data, lineUuid)`) instead of the main stream |
| `subagent.started` | `sink.started({toolCallId, name: agentDisplayName ?? agentName, description: agentDescription, agentType})` |
| `subagent.completed` / `subagent.failed` | `sink.settled(toolCallId, "completed" \| "failed")` |
| `session.error` | Status `⚠ GitHub Copilot: <message>` (+ ` — <remediation>`) |
| `session.warning` | Status `⚠ <message>` (this is where "effort unsupported" reports land, §8 A7) |
| `assistant.turn_retry` / `session.info` with a retry message | One status line per distinct message |
| `session.compaction_start` / `session.compaction_complete` | `context compacting…` / `context compacted` |
| `exit_plan_mode.requested` | Stash `planContent` on ctx |
| `abort` | Set `ctx.aborted` + status `turn aborted` |
| `result` | `done {code: exitCode ?? 0}` |
| `user.message`, every `ephemeral: true` delta, unknown types | Ignored (`exit_plan_mode.requested` is ephemeral but handled above) |
| Non-JSON line | `stderr`. A line matching `/No authentication information found/` additionally emits `COPILOT_LOGIN_STATUS_TEXT` once per run: "GitHub Copilot isn't logged in — run `copilot login` in a terminal (or set COPILOT_GITHUB_TOKEN in this harness's env)" (D8). |
| `model === "auto"` and the first `assistant.message.model` | Status `GitHub Copilot auto picked <model>` once per run (D23) |

**Settlement.**
- The turn resolves on `result` or process exit (exit file).
- An `abort` that agetor didn't initiate resolves non-zero. Agetor's own Stop is recorded `cancelled` by the orchestrator's existing flag, whatever the code (D21).
- **Before resolving**, the driver runs these steps in order:
  1. Wait up to 2 s for the exit file.
  2. Read the usage file → one `FX_USAGE_STATUS_PREFIX` sentinel (`copilot:usage:<runId>`) via `parseCopilotUsageFile`: tokens summed over `modelMetrics`, plus `aiCredits` per §3.4.
  3. In Plan mode, emit the plan chunk (§3.3).
  4. Call `sink.settleAll(code === 0 ? "completed" : "orphaned")`, so no stray `running` subagent row holds the task in `running`.

**Exports (pinned interface — wave-1 siblings code against it):**
- Paths: `copilotLogPath`, `copilotPromptPath`, `copilotExitPath`, `copilotUsagePath`.
- Mapper: `CopilotEvent`, `CopilotMapCtx`, `createCopilotMapCtx({runId, model, mode, turnStartedAt})`, `mapCopilotEvent`.
- Usage and plan helpers: `parseCopilotUsageFile`, `copilotPlanChunk(runId, content)`, `readCopilotPlanFile(copilotHome, sessionId, sinceMs)`.
- `CopilotSubagentSink {started, event, settled, settleAll}`.
- `CopilotLaunchOptions {taskId, runId, argv, env, cwd, promptText, onChunk, sessionId, copilotHome, mode, model, stripClassicTokens, onSubagent?, seenLineUuids?}`.
- Lifecycle: `spawnCopilotViaTmux`, `reattachCopilotSession`, `copilotSessionActive`, `dropCopilotSession`.
- Constants: `COPILOT_LOGIN_STATUS_TEXT`, `COPILOT_PLAN_TOOL_NAME = "copilot_plan"`.

A tiny `src/bun/copilot-home.ts` exports `copilotHome({harnessHome, harnessEnv, processEnv?})`, resolving in this order: harness env `COPILOT_HOME`, then `harness.home`, then the process `COPILOT_HOME`, then `~/.copilot`. agents.ts, the driver, commands.ts and the orchestrator share it.

### 3.2 Fake driver — `src/bun/copilot-fake.ts`

`AGETOR_COPILOT_DRIVER=fake` routes the default case to agents.ts's existing `makeFakeAgent`. It calls `onSessionId(resumeSessionId ?? "fake-copilot-session-<taskId>")` first.

Three prompt markers feed canned Copilot JSONL through the **real** `mapCopilotEvent`, the cursor-stream precedent:

- `__agetor_fake_copilot_stream__`: reasoning, a shell tool call and result, `auto` model status, a subagent that stays `running` for `AGETOR_FAKE_COPILOT_SUBAGENT_MS` (default 1500) with one nested tool call, then a usage sentinel.
- `__agetor_fake_copilot_plan__`: the stream plus `exit_plan_mode.requested`, producing the plan chunk.
- `__agetor_fake_copilot_auth__`: the unauthenticated stderr block, the login status line, exit 1.

`copilot-fake.ts` must not import `agents.ts`, to avoid a cycle.

### 3.3 Plan approval (D5)

Copilot has no plan tool call to anchor a card to. The driver therefore emits **one synthetic `tool_use`** at turn end, `{id: "copilot-plan:<runId>", name: "copilot_plan", input: {plan}}` with line uuid `copilot:plan:<runId>`, but only when the turn ran with `--mode plan` and a plan exists:

- First choice: the `planContent` of an `exit_plan_mode.requested` seen this turn.
- Otherwise: `plan.md` under `$COPILOT_HOME/session-state/<sessionId>/` whose mtime is ≥ the turn start.

Emitted last, it is the run's last `tool_use`. A new orchestrator `detectCopilotPlan` (beside `detectCursorPlan`, same never-throws contract) turns it into a `pending` `TaskPlan` via `upsertDetectedPlan`. The existing `PlanCard` substitution renders it with no new UI.

**Approve route, copilot branch** *(planner)*:
- Writes **no file** — no `.copilot/plans` in the user's repo, and nothing in Copilot's state dir.
- **Always embeds** the effective plan in the message: "The plan is approved — implement it now. Approved plan:" plus the content, with an "edited by the user — follow this version" variant.
- Records `filePath: null`, so `approvePlan` takes `string | null`.
- The rest mirrors cursor: an unbound Plan task flips to `auto` through a direct `tasks.update`, reverted if the send fails or isn't delivered. A bound task keeps Plan and gets `warning: "plan approved, but this task's agent runs GitHub Copilot in Plan mode — detach the agent or switch the mode to implement"`. The status line reads `plan approved — switched this task to Auto so GitHub Copilot can implement it`. `approvalsInFlight` blocks a double-approve. The guard becomes `planKindGuard` (cursor | copilot).

### 3.4 Usage chip and AI credits (D11b)

`FxUsagePayload` gains an optional `aiCredits?: number`; the driver fills its `turn` from the summed token metrics.

`aiCredits = totalNanoAiu / 1e9` is emitted only when `aiCreditsStatus !== "unavailable"` and the value is > 0. *(planner — the conversion is unverified.)* `fx-usage.ts` parses it and adds an "AI credits" line to the tooltip. RunPanel's usage gating adds `copilot`.

**If the live smoke can't confirm the conversion against Copilot's own credit display, task T17 removes `aiCredits` before merge.** A wrong number is not shipped.

**Outcome (Bug Fix step, after code review):** the live smoke was not run, so `aiCredits` was removed — `FxUsagePayload` has no such field, `parseCopilotUsageFile` ignores `totalNanoAiu`/`aiCreditsStatus`, and `fx-usage.ts` is back to its pre-copilot shape. The chip shows tokens only.

### 3.5 Subagent tabs (D12)

The orchestrator implements `makeCopilotSubagentSink(runId, taskId)`:
- **`started`**: `subagents.insertIfAbsent` with id `cp-<runId>-<toolCallId>` (globally unique), `parentKind: "subagent"`, `sourcePath` = the run's log path, `spawnDepth: 1`, `toolUseId: toolCallId`.
- **`event`**: `runs.appendEvent(runId, stream, data, lineUuid, subagentId)` plus the same `emit` the claude watcher uses.
- **`settled` and `settleAll`**: `subagents.setStatus` plus `maybeReleaseHeldTask`. `settleAll` uses a new `subagents.settleRunningForRun(runId, status, now)`.

RunPanel's tab strip is already kind-agnostic.

### 3.6 Model list and effort (D3, D7, D9, D25)

**Models.** `AGENT_OPTIONS.copilot.models` lists the 14 curated rows in D9 order, `auto` first. `DEFAULT_MODEL.copilot = "auto"`. `discoverCopilot` parses `copilot help config` (env: `harnessEnv` + `COPILOT_OFFLINE=true`, 4 s budget). Copilot is **not** in `CATALOG_SCOPED_KINDS`.

**Efforts.** `MODEL_EFFORT_SUPPORT.copilot` has **no `ultra`**, because Copilot's flag accepts none…max:

| Models | Effort ids |
| --- | --- |
| claude-opus-5.5, claude-sonnet-5.5, claude-haiku-5.5, claude-fable-5.1 | `max, xhigh, high, medium, low, auto` (the claude-code table) |
| gpt-6.1-sol, gpt-6-astra | `max, xhigh, high, medium, low, auto` (codex minus `ultra`) |
| gpt-6-sol, gpt-6-luna | `max, xhigh, high, medium, low, none, auto` |
| gemini-4-argon | `high, medium, low, auto` (fx table) |
| gemini-3.8-flash | `high, low, auto` (fx table) |
| grok-4.7 | `xhigh, high, medium, low, auto` (fx table) |
| kimi-k3 | `max, high, low, auto` (fx table) |
| `auto`, mai-code-1.1-flash | `max, xhigh, high, medium, low, minimal, none, auto` (Copilot-only ids get the full set; §8 A6) |

- A discovered-only id falls back to `DEFAULT_MODEL`'s set, i.e. the full set.
- `DEFAULT_EFFORT.copilot = "auto"`.
- `supportedEfforts`' discovered-set `auto` filter widens from fx to fx + copilot through a `MODEL_DEFAULT_EFFORT_KINDS` set. The `EFFORT_OPTIONS` `auto` hint is reworded to "fx and GitHub Copilot".

**Other tables.**
- `MODEL_MIN_CLI_VERSION.copilot` = the floor table in §2.
- `MODEL_MODE_DENY.copilot = {}`.
- `CODE_PLAN_MODE.copilot = {code: "auto", plan: "plan"}`.
- `supportedSpeeds` already returns `["off"]`.

### 3.7 Orchestrator wiring (D13, D14, D21, D24)

**Queue.** `copilotTurnQueue` + `sendCopilotTurn` / `spawnCopilotTurnNow` / `drainCopilotQueue` are modelled on **codex's** queue: the floor re-check moves a refused queued follow-up to the backlog tray, and `declined` is honored. They use **gemini's** self-issued id: `--session-id` is always passed — the prior id when resuming, else a fresh uuid.

**Resume lookup.** `findLastCopilotSessionId(taskId, harnessId)` filters `runs.agent = harnessId`. Two cases print a status line and start fresh:
- No own-harness session exists but another harness has one: `previous GitHub Copilot context is on harness "<other>" — starting a fresh session (context didn't carry over)`.
- The session dir is missing under this `COPILOT_HOME`: `previous Copilot session <id8>… not found for this account — starting fresh`.

**Other edits.**
- `sendInput`'s early floor gate widens from codex to codex + copilot.
- The `onSessionId` ternary becomes `sessionIdPatchFor(kind, id)`, an exhaustive switch that throws on unknown.
- Reconcile: `copilot_session_id` joins the SELECT, the key chain and the kind gate, and `reattachCopilotSession` is called with seeded `seenLineUuids` and the subagent sink.
- Copilot is dropped on agent-switch, archive and delete, and the queue is cleared on switch and delete (the `80c015f` lesson).
- `detectCopilotPlan` runs in `attachDoneHandler`. The subagent sink is passed at all three copilot spawn sites.
- tmux launch failures surface through `spawnAgentOrFail` (the `80c015f` lesson).

### 3.8 Exhaustive dispatch (D13) — one deviation

`buildCommand`, `spawnAgent` and `sessionIdPatchFor` end in an explicit last branch plus a `never` check that throws `unknown harness kind: <kind>`. Codex becomes an explicit `if (kind === "codex")`. Launch paths already turn a throw into a clean failed run (`spawnAgentOrFail`).

`harnessEnv` gets the explicit gemini and copilot (`COPILOT_HOME=<home>`) branches and a compile-time `never` check, but at runtime an unknown kind (a retired `grok`/`kimi` row) **sets no home var and warns once instead of throwing**. *(planner — deviates from D13's wording; §8 A1.)* `checkHarness` calls `harnessEnv` for every harness row (`agent-status.ts:522`), so a throw would break `GET /harnesses` for those rows (KB `49246867`).

### 3.9 Capability discovery (D11c) *(planner, on the representation of agents)*

The copilot branch in `listAvailableCommands` / `discoverMcpAndPluginExtensions`:

- **User skills:** `$COPILOT_HOME/skills`, plus `~/.agents/skills` (HOME-relative).
- **Project skills:** `.github/skills`, `.agents/skills`, `.claude/skills`. No builtins.
- **MCP:** `$COPILOT_HOME/mcp-config.json` (user); `.mcp.json` and `.github/mcp.json` (project). The `mcpServers` key is accepted, and `servers` too for `.github/mcp.json` (§8 A8).
- **Custom agents:** `$COPILOT_HOME/agents/*.md` (user) and `.github/agents/*.md` (project). They become a **new extension kind `"agent"`** with insert `@<name>` (name from frontmatter `name:`, else the filename minus `.agent.md`/`.md`). This shows as an "Agents" group in the Extensions picker, collapse order `{mcp, skill, plugin, agent}`.
- **Ref-mode support:**
  - `CAPABILITY_READ_PATTERNS` gains `^\.github/skills/[^/]+/SKILL\.md$`, `^\.github/mcp\.json$` and `^\.github/agents/[^/]+\.md$`.
  - `DEFAULT_PATHSPECS` gains `.github`.
- `bundle.ts`' `userLevelSkills` gate adds copilot.

### 3.10 Identity, status, hints (D16–D18)

- `resolveBin`: `copilot` / `AGETOR_COPILOT_BIN`.
- `checkHarness` (copilot): a `--version` output not containing `"GitHub Copilot CLI"` is unavailable with the reason "`copilot` isn't GitHub Copilot CLI (AWS Copilot ships a binary of the same name)" and the install hint. `loggedIn` stays `null` (D8).
- `INSTALL_HINTS.copilot = "brew install --cask copilot-cli"`.
- `BREW_PACKAGES.copilot = "--cask copilot-cli"`, so a Homebrew install's hint is `brew upgrade --cask copilot-cli`; otherwise `copilot update`.
- Onboarding `LOGIN_COMMAND.copilot = "copilot login"`; the `agetor harness shell` hint is `run <launch> login`.
- `HARNESS_HOME_COPY.copilot` documents `COPILOT_HOME=<path> copilot login`.
- `HARNESS_TEMPLATES` gains `copilot-additional` (`copilot-2`, `{dataDir}/harnesses/copilot-2`).
- The built-in row's label is "GitHub Copilot"; the icon is `GithubCopilot.Mono`.

### 3.11 Migration (D26)

`src/bun/migrations/075_copilot_harness.sql` (provisional number):
1. Rebuild `harnesses` with CHECK `('claude-code','codex','cursor','grok','gemini','kimi','fx','antigravity','opencode','copilot')`.
2. Copy all **11** columns explicitly, `profile_mcp_servers` included.
3. Seed `('copilot','copilot','GitHub Copilot',1,…,enabled=1)` with `INSERT OR IGNORE`.
4. Self-heal re-seed the seven built-ins this branch knows. opencode seeds its own.
5. `ALTER TABLE runs ADD COLUMN copilot_session_id TEXT`.

`Run.copilotSessionId?` is **optional** (the antigravity precedent), so the ~10 `runs.insert` literals need no change.

**Renumber rule at merge.** If `main` already has 075/076 (gpt-6-1-terra) or an opencode migration, rename the file to the next free number, register it with `aliases: ["075_copilot_harness"]` (dev DBs that applied it keep working) and re-pin `migrate.test.ts`'s "last migration" test.

### 3.12 Rejected alternatives

| Alternative | Why not |
| --- | --- |
| ACP driver | Loses restart survival (owner D1) |
| Writing an approved plan to `.copilot/plans/` | Leaves untracked files in the user's repo for no benefit; the agent gets the plan inline anyway |
| A flat "subagent events interleaved in main" | Owner chose tabs |
| Plan anchored on a real tool call | No stable tool call is documented in `-p`; the synthetic chunk is deterministic and reuses all plan UI |
| Throwing in `harnessEnv` at runtime | §3.8 |
| Checking `process.env` for `ghp_` tokens | The tmux server's env can differ; the shell guard checks the real pane env |

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| **T1** | Shared types and tables for `copilot` | `src/shared/types.ts`; existing tests it breaks: `src/shared/types.test.ts`, `src/shared/speed.test.ts`, `src/bun/effort-support.test.ts` | — | **Kind and tables:** `AgentKind` includes `copilot`; `AGENT_OPTIONS.copilot` (14 models, 3 modes with D22 copy, `EFFORT_OPTIONS`); `DEFAULT_MODEL`/`DEFAULT_EFFORT` (`auto`/`auto`); `CODE_PLAN_MODE`; `MODEL_EFFORT_SUPPORT.copilot` per §3.6; `MODEL_MODE_DENY.copilot = {}`; `MODEL_MIN_CLI_VERSION.copilot` per §2. **Effort `auto`:** `supportedEfforts` keeps `auto` for copilot via `MODEL_DEFAULT_EFFORT_KINDS`; the `EFFORT_OPTIONS` `auto` hint is reworded. **Other fields:** `Run.copilotSessionId?: string \| null`; `FxUsagePayload.aiCredits?`; `HARNESS_TEMPLATES` `copilot-additional`; `Harness.home` doc bullet (COPILOT_HOME). **Tests:** the kind-iterating tests pass. |
| **T2** | Migration + db layer | `src/bun/migrations/075_copilot_harness.sql` (new), `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/migrate.test.ts`, `src/bun/harnesses.test.ts` | T1 (type only) | **Migration:** a 074 DB with built-ins, an alias row with home, `profile_mcp_servers=0` and a `grok` row migrates with every row and column intact; `copilot` is seeded enabled; re-run is a no-op; `runs.copilot_session_id` exists. **db.ts:** `getByIdOrKind("copilot")` returns the synthetic built-in "GitHub Copilot"; `harnesses.insert` accepts `copilot`; `RunRow`/`toRun`/insert/update carry `copilot_session_id`; new `subagents.settleRunningForRun(runId, status, now)` changes only that run's `running` rows. **Tests:** the last-migration test is re-pinned to 075. |
| **T3** | Copilot tmux driver + fake streams + home helper | `src/bun/copilot-tmux.ts`, `src/bun/copilot-fake.ts`, `src/bun/copilot-home.ts` (all new) | T1 | Exports exactly the §3.1 interface; mapper table §3.1; settle order §3.1; plan chunk rule §3.3; usage parse §3.4; the shell wrapper's token/allow-all guards; death watch; reattach from offset 0 with seeded uuids; launch failure throws (not a silent hang). Fake markers per §3.2 feed the real mapper. No import of `agents.ts`/`orchestrator.ts`. |
| **T4** | Agent dispatch + exhaustive throws | `src/bun/agents.ts`, `src/bun/agents.test.ts` (existing kind-iterating cases only) | T1, T3 interface | **Dispatch:** `resolveBin` copilot; `harnessEnv` copilot `COPILOT_HOME` + explicit gemini + compile-time `never` + runtime no-throw (§3.8); `buildCommand` copilot branch builds the §3.1 argv/env/`stripClassicTokens`/usage path; `spawnAgent` copilot branch calls `spawnCopilotViaTmux`, or the fake seam per §3.2. **Args:** `SpawnAgentArgs.copilotSubagents?: CopilotSubagentSink` added. **Exhaustive throws:** the codex branch is explicit, and both functions throw `unknown harness kind: grok` for a retired kind instead of building codex. **Tests:** the existing agents tests stay green. |
| **T5** | Status probe + model discovery | `src/bun/agent-status.ts`, `src/bun/agent-discovery.ts`, `src/bun/agent-status.test.ts`, `src/bun/agent-discovery.test.ts` (existing pinned lists only) | T1, T4 (`harnessEnv`/`resolveBin`) | **Status:** `INSTALL_HINTS`/`BREW_PACKAGES`/`upgradeHintFor` per §3.10; `checkHarness` version-marker gate (AWS stub → unavailable + reason; GitHub stub → available, version parsed, `loggedIn: null`). **Discovery:** `parseCopilotModels` (the `model` block of `help config`), `discoverCopilot`, `runRefresh` list/kinds (index-aligned), `runRefreshKind` case, exports. |
| **T6** | Webview: harness surfaces | `src/mainview/components/kanban/AgentIcon.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/components/onboarding/OnboardingChecklist.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/api.ts`, `src/mainview/components/kanban/ExtensionPicker.tsx` | T1 | **Settings:** the icon is `GithubCopilot.Mono`; `isExperimentalKind` includes copilot; `HARNESS_HOME_COPY.copilot` per §3.10; the kind list includes copilot. **Onboarding:** `LOGIN_COMMAND`. **Model maps:** both `AgentModelMap`s have `copilot: []`. **Extensions:** api.ts `AvailableExtension.kind` adds `"agent"`; ExtensionPicker gets an "Agents" group (lucide `Bot`). **Gate:** typecheck green. |
| **T7** | Webview: launch, run panel, plan, usage | `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/PlanDialog.tsx`, `src/mainview/lib/fx-usage.ts`, `src/mainview/lib/fx-usage.test.ts` | T1 | **Launch forms:** NewTaskForm seed entry + `seed("copilot")` + Plan-button title ("Routed to Copilot's --mode plan — approving the plan switches the task to Auto"); TaskLaunchPickers' map. **Run panel:** RunPanel `plans` gating adds copilot, usage gating adds copilot. **Plan dialog:** PlanDialog is `editable` for copilot ∧ pending, with copy no longer cursor-only. **Usage:** fx-usage parses and tooltips `aiCredits` (tests). **Gate:** typecheck green. |
| **T8** | Orchestrator wiring | `src/bun/orchestrator.ts` | Wave 1 (T1–T5) | Everything in §3.7 plus the §3.5 sink. Edge cases: a queued follow-up refused by the floor goes to the backlog with a status line; a harness switch mid-queue clears the queue; delete/archive kill the tmux session; a Stop mid-turn records `cancelled`. |
| **T9** | Server routes + plan transforms | `src/bun/server.ts`, `src/bun/task-plans.ts`, `src/bun/task-plans.test.ts` (existing) | Wave 1 | **Harness routes:** `POST /harnesses` accepts `copilot` (error copy lists it); both `/agent-models` maps carry `copilot`. **Plan routes:** `planKindGuard` (cursor\|copilot) on PATCH and approve; the approve copilot branch per §3.3 (no file, embedded plan, flip/revert, bound warning, in-flight 409); `approvePlan` takes `filePath: string \| null`; cursor behaviour is byte-identical. |
| **T10** | Capability discovery | `src/bun/commands.ts`, `src/bun/ref-tree.ts`, `src/bun/bundle.ts` | Wave 1 (T3's `copilot-home.ts`, T6's api type) | The §3.9 dirs/files are discovered on live disk and at a ref (`.github` in pathspecs); custom agents surface as kind `agent` rows; project wins over user on a clash; gemini/antigravity behaviour is unchanged; `userLevelSkills` covers copilot. |
| **T11** | CLI parity | `src/cli/commands/harness.ts` | Wave 1 | The `agetor harness shell` hint for copilot is `run <launch> login`. Verified, no edit expected: `agetor add`/`edit`/`profile` pickers list Copilot models and efforts from `AGENT_OPTIONS`, and `agetor harness ls` prints copilot rows (profile-mcp `-`). Any real gap found is fixed in this file or reported. |
| **T12** | Docs | `CLAUDE.md`, `README.md` | Wave 2 | **CLAUDE.md:** a new `copilot` bullet in "Agent command shape" (argv, env, modes, plan card, subagents, usage, login, tokens, floors); `AGETOR_COPILOT_BIN/ARGS` + `AGETOR_COPILOT_DRIVER=fake` added to the env and fake-driver lists; the "To add a new agent kind" paragraph replaced with the real checklist (KB `805945c6` + this plan's §9); the `Harness.home` multi-account notes. **README.md:** harness table, mermaid, env table and mentions (`:8, 34, 44, 47, 79-84, 264, 272, 294, 310-313, 403, 413`). |
| **T13** | e2e fixture | `e2e/fixtures.ts` | Wave 2 | `AGETOR_COPILOT_DRIVER=fake` is set for every worker. A copilot stub script (`--version` → `GitHub Copilot CLI 1.0.104.`; `help config` → a `model` block with the curated ids plus `gpt-5.4-mini`) is written to `<dataDir>/copilot-stub-bin/copilot`. `AGETOR_COPILOT_BIN` points at it **only** when `backendEnv.AGETOR_E2E_COPILOT_STUB === "1"`, so existing specs keep seeing Copilot as not installed (as they see Antigravity). |
| **T17** | Live-smoke follow-through | Whatever file the smoke proves wrong (expected: `src/bun/copilot-tmux.ts`, `src/mainview/lib/fx-usage.ts`, `src/shared/types.ts`, docs) | Wave 4 smoke | Each mismatch the smoke finds is fixed with a regression test. Two contingent fixes: `aiCredits` is removed if it can't be confirmed (§3.4), and the multi-account template's help is reworded if `COPILOT_HOME` doesn't isolate logins (§8 A5). Re-run wave 4's gate afterwards. |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| **TT1** | unit | T3 | `src/bun/copilot-tmux.test.ts` (new) | Table-driven `mapCopilotEvent` over **synthetic** lines of each §3.1 shape: `parentToolCallId` routing; the `reasoningText` fallback only when no `assistant.reasoning`; the `auto` status once; the login status once; ephemeral/unknown ignored; `abort` → non-zero; stable `copilot:<id>` uuids. `parseCopilotUsageFile`: sums models, credits gating. `readCopilotPlanFile`: mtime gate. `copilotPlanChunk` shape. `buildCopilotShellCommand`: token guards and `COPILOT_ALLOW_ALL` unset per mode, quoting. Spawn/settle/death/reattach through the existing tmux test seam (mirror `antigravity-tmux.test.ts`). |
| **TT2** | unit | T4 | `src/bun/agents-copilot.test.ts` (new) | **Argv** per mode × effort (`auto`/null omit the flag) × resume, with `--mode` always present, `--allow-all` only in Auto, `AGETOR_COPILOT_ARGS`, usage path. **Env:** `COPILOT_HOME` pin precedence (harness env > home > process > `~/.copilot`); `COPILOT_ALLOW_ALL` only in Auto and never overriding the harness env; `stripClassicTokens` excludes harness-set vars; `harnessEnv` copilot. **Dispatch:** `resolveBin`; `buildCommand`/`spawnAgent` throw for `grok`; `harnessEnv` doesn't throw for `grok`; the fake seam fires `onSessionId`. |
| **TT3** | unit | T5 | `src/bun/copilot-status-discovery.test.ts` (new) | GitHub vs AWS stub through `checkHarness`; the version is parsed by `cliVersionSatisfies`; `upgradeHintFor` cask / brew / non-brew; `parseCopilotModels` on a fixture `help config` text (block boundaries, ignores other blocks); `discoverCopilot` via the stub; `runRefreshKind("copilot")`. |
| **TT4** | integration | T8 | `src/bun/orchestrator-copilot.test.ts` (new) | Fake driver with `AGETOR_DATA_DIR` in `mkdtemp`. **Start and resume:** start → run row + session id column + column moves. **Queue:** a follow-up while busy queues then drains with the same session id; same-kind harness switch → fresh id + status line; floor refusal for a queued follow-up → backlog + status. **Plans and subagents:** the plan marker → a `pending` plan; the stream marker → subagent row running → completed, events tagged with the subagent id, task not held. **Teardown and restart:** delete/archive/switch call the drop and clear the queue; reconcile of a `running` copilot run reattaches; a dead session → `orphaned`; a Stop → `cancelled`. Must call `rmTestDataDir` and never real tmux on the user socket. |
| **TT5** | integration | T9 | `src/bun/server-copilot-plan.test.ts` (new) | HTTP: `POST /harnesses {kind:"copilot"}` → 201; `/agent-models` includes `copilot`. **Plan approve on a copilot task:** an unbound task flips to `auto` and the message embeds the plan; an edited plan uses the edited text; a bound task keeps `plan` and returns `warning`; a failed send reverts the flip; a concurrent approve → 409; a codex task → 400 with the new copy. |
| **TT6** | integration | T10 | `src/bun/commands-copilot.test.ts` (new) | Temp HOME + `COPILOT_HOME` + temp git repo: user/project skills, MCP from all three files (`mcpServers`/`servers`), agents (frontmatter name and filename fallback) on live disk; the same entries at a committed ref (`.github/…` read via `ls-tree`); project overrides user; the `agent` kind sorts last; `userLevelSkills` for copilot. |
| **TT7** | e2e | T6, T7, T8, T9, T13 | `e2e/copilot-harness.spec.ts` (new) | See the scenario list after this table. |
| **TT8** | integration (real binary, opt-in) | T3, T4 end-to-end | `src/bun/copilot-real-binary.test.ts`, `src/bun/test-support/copilot-fake-provider.ts` (both new) | Skipped unless `AGETOR_COPILOT_REAL_BIN` is set and passes the marker, and `tmux` exists. See the details after this table. |

**TT7 scenarios** (`test.use({ backendEnv: { AGETOR_E2E_COPILOT_STUB: "1" } })`):
1. Settings → Harnesses shows "GitHub Copilot" with the Experimental badge, enabled and available. Add-harness from the `copilot-additional` template shows the COPILOT_HOME help.
2. New Task on Copilot: the model picker defaults to Auto and lists a discovered-only `gpt-5.4-mini`; effort defaults to "Model default"; no Speed control; modes Auto / Plan / Read-only.
3. Stream marker: thinking block, tool card, "auto picked" status line, usage chip on the run row, and a subagent tab while the subagent is running whose transcript shows the nested tool call.
4. Plan marker in Plan mode: plan card → dialog → edit → Approve → task details show Auto + the flip status line.
5. Auth marker: login status line, run failed.
6. A follow-up sent mid-turn runs as the next turn with a "resuming GitHub Copilot session" status.

**TT8 details.**
- Ports the 84-line spike fake OpenAI SSE provider to an in-process `Bun.serve` on an ephemeral port, with modes text / shell-tool / 500 / slow.
- Runs **through `buildCommand` + `spawnCopilotViaTmux`** with BYOK env (`COPILOT_OFFLINE=true`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE=openai`, temp `COPILOT_HOME`) on the agetor test tmux socket.
- Asserts:
  - an assistant chunk and `result` settle;
  - Auto runs the shell tool (`tool_use` + successful `tool_result`), while Read-only gets `isError` "Permission denied…";
  - a second turn with the same id resumes (the model sees prior messages in the fake provider's request log);
  - `--mode plan` reaches Copilot (`[[PLAN]]` user prefix in the provider log);
  - the usage file parses into a sentinel;
  - a Stop resolves without success and the orchestrator flag can mark it cancelled;
  - the provider 500 → `session.error` status + non-zero;
  - a missing provider and no auth → the login status line.
- Also **records, without asserting,** whether `assistant.reasoning` appears when the provider streams a reasoning delta, and what a prompt starting with `/<skill>` does (§8 A9), into the test output for the live-smoke step.

**E2e decision:** **applies.** The change has user-visible flows (Settings, New Task, run panel, plan card, subagent tabs) and crosses webview → API → orchestrator → driver. The fake driver (`AGETOR_COPILOT_DRIVER=fake`) feeding the real mapper keeps the spec deterministic.

**Run recipe:**
```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                   # fresh worktree has no node_modules
bun run typecheck
bun test                                      # full unit/integration; known pre-existing failures: tmux-socket ×2 + one reconcile cancel test
bun test src/bun/copilot-tmux.test.ts         # single file
bun node_modules/@playwright/test/cli.js test e2e/copilot-harness.spec.ts   # one Playwright process at a time
bun node_modules/@playwright/test/cli.js test # full e2e (serial with any other Playwright run)
# Opt-in real-binary test (no auth, no network, no billing):
npm i --prefix "$SCRATCH/copilot" @github/copilot@1.0.104   # Node ≥ 22; or reuse the step-1 spike copy under its scratchpad
AGETOR_COPILOT_REAL_BIN="$SCRATCH/copilot/node_modules/.bin/copilot" bun test src/bun/copilot-real-binary.test.ts
```

E2e services: `e2e/fixtures.ts` starts a headless backend per worker with `AGETOR_DATA_DIR` in a temp dir, the fake-driver env and a GitHub API stub. No seed data or credentials are needed.

## 6. Execution waves

Each wave ends in a checkpoint commit. The barrier is `bun run typecheck` green plus `bun test` green except the three known pre-existing failures.

| Wave | Tasks (parallel, file-disjoint) | Barrier notes |
| --- | --- | --- |
| **1 — foundation and leaves** | T1, T2, T3, T4, T5, T6, T7 + TT1, TT2, TT3 | Every site the typechecker flags lands here together (types, `INSTALL_HINTS`, `AgentIcon`, `HARNESS_HOME_COPY`, `resolveBin`, `runRefreshKind`, picker maps), so the barrier is green. T4/T5 code against T3's pinned §3.1 interface and T1's types. Copilot launches at the agents layer but isn't yet wired in the orchestrator: queue, reattach and plan detection come in wave 2. No test exercises that gap. |
| **2 — runtime wiring** | T8, T9, T10, T11 + TT4, TT5, TT6 | T10 reads T6's widened `AvailableExtension` type (wave 1). T9's guard and T7's UI gating meet here. Barrier green. |
| **3 — docs, e2e, real binary** | T12, T13 + TT7, TT8 | TT7 needs T13's fixture in the same wave (separate files). TT8 is skipped in a plain `bun test` (no env var), so it can't redden the barrier. |
| **4 — full verification** | (no new files) Run the whole recipe: typecheck, `bun test`, TT8 with the real binary, the full e2e suite once. Fix clusters by root cause (test-loop), at most three rounds. | Green suite plus TT8 output captured for the live smoke. |
| **5 — live smoke (owner-gated)** | Owner runs `brew install --cask copilot-cli` and `copilot login`. Then on `bun run dev` (**`~/.agetor-dev` only**), smoke one task per mode with synthetic prompts. Then T17 for any mismatch. | See the per-mode checks after this table. **If the owner can't install or log in, this wave is reported as not run** — mapper verified against BYOK only — not silently skipped. |

**Wave 5 per-mode checks:**
- **Auto:** an edit lands and the tool card renders; the thinking stream appears (or the gemini-style gap is recorded); the usage chip shows tokens; the credits value is compared to Copilot's own display; the `auto picked` line names a real model.
- **Plan:** the plan card appears from `exit_plan_mode.requested` or plan.md; Approve flips to Auto and implements.
- **Read-only:** edits are denied and the run succeeds with the D22 copy.
- **Plus:** a follow-up resumes context; a Stop → `cancelled`; quit + relaunch mid-turn reattaches; optionally a second account via the template (§8 A5).
- Real JSONL is captured to the scratchpad, never into the repo verbatim.

**Overlap check (done):** no path appears twice within a wave. `api.ts` is T6 only (wave 1); `RunPanel.tsx` is T7 only. `types.ts`, `db.ts`, `agents.ts`, `orchestrator.ts` and `server.ts` each have exactly one owner. Existing test files are owned by the task whose module they pin; new test files are owned only by TT tasks.

## 7. Blast radius & risks

- **Exhaustive throws change existing failure modes.** A harness row of a retired kind (`grok`/`kimi`) that someone launches now fails cleanly ("unknown harness kind") instead of running codex. That is intended. `harnessEnv` stays non-throwing so the status/listing paths don't regress (§3.8).
- **The migration is a table rebuild.** It is safe because no FK points at `harnesses` (verified). The prod harnesses-table wipe (KB `867db5cf`) was an order-dependent CHECK, so the union CHECK + `INSERT OR IGNORE` + explicit 11-column copy is pinned by T2's test with a `grok` row and `profile_mcp_servers=0`.
- **Renumbering** after gpt-6-1-terra/opencode follows §3.11. Both concurrent branches also edit the same `Record<AgentKind>` tables, so expect textual merge conflicts in `types.ts`, `agents.ts`, `orchestrator.ts` and `SettingsDialog.tsx`. If OpenCode merges first, its CHECK list already includes `copilot` (agreed), and the auto-enable rule (KB `9f11635f`) is a no-op for a seeded-enabled row.
- **Enabled by default** means every user sees a "GitHub Copilot — not installed" row and picker entry, as with Antigravity (D2). Existing e2e specs are shielded by T13's opt-in stub.
- **Cancel exits 0.** Covered by the orchestrator's `cancelled` flag; an `abort` agetor didn't send resolves non-zero (TT1, TT4).
- **Plan mode is sticky.** `--mode` on every turn (TT2). A task switched Plan → Auto stops planning.
- **Auto trusts the worktree.** Its MCP servers and hooks load, and a hanging MCP server stalls the turn (spike: >60 s). That is the same exposure as the interactive CLI; it shows as "Agent is working…" and Stop works.
- **Ambient tokens and allow-all.** Guarded in the pane shell (TT1). A `gho_`/`github_pat_` token in the user's env still overrides their keychain login, as Copilot documents (D10 accepts this).
- **AWS Copilot** on PATH is refused by name. A Homebrew hint without `--cask` would upgrade the AWS formula; fixed via `BREW_PACKAGES`.
- **First-launch extraction.** The npm loader extracts ~204 MB on first launch; the first `--version` probe may exceed `probeVersion`'s budget; the row then shows no version (still available; the identity gate is skipped) until the next 15 s poll. This is documented in the CLAUDE.md bullet and not otherwise handled.
- **Contract drift.** The CLI ships near-daily and auto-updates. The mapper ignores unknown types; TT8 can be re-run against any new version in minutes.
- **Copilot model ids collide** with other kinds' literals (`gpt-6.1-sol`, `gemini-4-argon`, …). Any future normalize/retire migration for copilot rows must join `harnesses.kind = 'copilot'` (KB `79ea4a46`). This goes into the CLAUDE.md bullet.
- **Subagent hold.** A copilot subagent row left `running` would hold the task in `running`. `settleAll` before resolve plus the reconcile path prevent it (TT4).
- **Rollback.** Code reverts cleanly. The migration is additive (a new CHECK member, a new nullable column, a new row), so an older build reading a migrated DB keeps working; a copilot row would just be an unknown-kind row (tolerated like `grok`).

## 8. Open questions / assumptions

The owner approved the plan with these as written (2026-10-27). Each still names how it gets verified or reversed.

- **A1 — `harnessEnv` does not throw at runtime** (deviates from D13's wording). It has a compile-time `never` check and explicit branches, and an unknown runtime kind sets no home var and warns once. *Why:* `checkHarness` calls it for every harness row, and retired `grok`/`kimi` rows exist; a throw would break the harness list. The other three dispatch points do throw.
- **A2 — The approved plan is embedded in the message; no plan file is written** (§3.3). *Why:* D5 asks for "the cursor flow" without naming a file. Writing into the user's repo or Copilot's state dir is avoidable, and embedding works in every mode.
- **A3 — Plan source.** An ephemeral `exit_plan_mode.requested` this turn, else plan.md modified this turn. *If neither appears in real `-p` runs,* the plan card has no source. The live smoke decides, and T17 adjusts (e.g. reading plan.md regardless of mtime when the turn was Plan).
- **A4 — AI credits = `totalNanoAiu / 1e9`, unverified.** Removed by T17 unless the smoke confirms it.
- **A5 — A separate `COPILOT_HOME` isolates a second login** (the keychain entry may be per host+user). *If wrong:* T17 rewords the template help to set `COPILOT_GITHUB_TOKEN` in the harness env. Verified only if the owner has a second account; otherwise reported unverified.
- **A6 — Copilot-only ids** (`auto`, `mai-code-1.1-flash`, discovered-only) offer the full none…max ladder plus Model default. Harmless, because Copilot reports and ignores an unsupported level (changelog 1.0.88).
- **A7 — The "unsupported effort" report surfaces** as `session.warning` or `session.info`, both mapped to status lines. Unconfirmed; TT8 or the smoke shows it.
- **A8 — `.github/mcp.json` may use the `servers` key** (VS Code shape) rather than `mcpServers`, so both are accepted.
- **A9 — Inserting a skill as `/name` into a Copilot prompt behaves sensibly in `-p`.** TT8 records the behaviour. *If Copilot treats it as an unknown slash command and refuses,* T10 switches copilot skill inserts to a plain mention, a contained change in the copilot branch.
- **A10 — `assistant.reasoning` reaches stdout** (else the `reasoningText` fallback, else a recorded gemini-style gap). The real backend emits the same JSONL as BYOK. Both are checked by the smoke.
- **A11 — Migration number 075 is provisional** (§3.11).
- **A12 — The owner can install and log in for wave 5.** The device/browser login needs a human.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Kind union + every `Record<AgentKind>` table (types) | In this run | T1 |
| `MODEL_DEFAULT_EFFORT_KINDS` (`auto` effort kept for copilot) + hint copy | In this run | T1 |
| `Run.copilotSessionId?`, `FxUsagePayload.aiCredits?`, `HARNESS_TEMPLATES` entry, `Harness.home` doc | In this run | T1 |
| Harnesses rebuild migration (union CHECK, 11 columns, seed, self-heal, runs column) + registration + test re-pin | In this run | T2 |
| `getByIdOrKind`, `harnesses.insert` whitelist, runs session column mapping | In this run | T2 |
| `subagents.settleRunningForRun` | In this run | T2 |
| Driver (mapper, tailer, reattach, drop, usage, plan chunk, login line, auto-model line, token/allow-all guards) | In this run | T3 |
| Fake driver + three markers | In this run | T3 |
| `copilotHome` helper shared by spawn/driver/discovery | In this run | T3 |
| `resolveBin`, `harnessEnv`, `buildCommand`, `spawnAgent` copilot branches + exhaustive throws | In this run | T4 |
| `buildHarnessTerminalCommand` / harness shell env | In this run | Covered by T4's `harnessEnv` branch |
| Install / upgrade (`--cask`) hints, version-marker gate | In this run | T5 |
| Model discovery from `help config` (kind-level) | In this run | T5 |
| Per-harness copilot discovery (`model-discovery.ts`) | Out of scope | The list is static per CLI version, not account-scoped; kind-level discovery is exact |
| Settings: icon, experimental badge, home copy, kind list; Onboarding login; App/api model maps | In this run | T6 |
| Extensions "Agents" group (new extension kind) | In this run | T6 (UI) + T10 (data) |
| NewTaskForm/TaskLaunchPickers seeds and copy; RunPanel plans + usage gating; PlanDialog editable; fx-usage credits | In this run | T7 |
| Orchestrator: queue/drain, harness-scoped resume, missing-session notice, floor gate on follow-ups, reconcile reattach, session-id switch, drops/clears on switch/archive/delete, plan detection, subagent sink | In this run | T8 |
| Launch-failure surfacing + queue clear on delete (Antigravity's `80c015f` misses) | In this run | T3 (throw) + T8 (clear) |
| `POST /harnesses` kind + copy, `/agent-models` maps, plan guard + approve branch, `approvePlan` nullable path | In this run | T9 |
| Copilot skills/MCP/agents discovery, `.github` ref-tree pathspec, read patterns, bundle `userLevelSkills` gate | In this run | T10 |
| CLI harness-shell login hint; verify `add`/`edit`/`profile`/`harness ls` | In this run | T11 |
| CLAUDE.md (command-shape bullet, env and fake lists, real "add a kind" checklist), README | In this run | T12 |
| e2e fixture (fake driver + opt-in stub) + Copilot spec | In this run | T13, TT7 |
| Unit/integration tests per module | In this run | TT1–TT6 |
| Real-binary BYOK integration test | In this run | TT8 (owner D15) |
| Live smoke per mode + fixes it finds | In this run (owner-gated) | Wave 5 + T17 (owner D15); reported as not run if the owner can't log in |
| Bundle import/export `knownKinds`, `parseAgentProfileSnapshot` kind set | No change needed | Both derive from `AGENT_OPTIONS`; covered by the kind-iterating tests (`types.test.ts:84`, `agent-profiles.test.ts:444`) |
| `supportedSpeeds` | No change needed | Already `["off"]` for non-cursor/fx; T1 adds a speed test case |
| TUI dashboard / `agetor logs` rendering | No change needed | Kind-agnostic streams; the usage sentinel is already suppressed by `isInternalStatusSentinel` |
| Existing-data backfill | None needed | New kind, new nullable column, seeded row |
| TODO tracker from Copilot's session SQLite | Owner-deferred | Owner, grill D12 (undocumented SQLite schema) |
| Account quota in the usage tracker (`USAGE_SUPPORTED_KINDS`) | Owner-deferred | Owner, grill D12 (no documented quota API) |
| Assisted (`--assisted-approval`) and Autopilot modes | Owner-deferred | Owner, grill D4 |
| `--max-ai-credits` guardrail | Owner-deferred | Owner, grill D25 |
| ACP driver / interactive permission cards / Ask mode | Out of scope | Owner chose tmux (D1); a different architecture |
| Harness-scoped resume for codex/cursor/gemini/antigravity/fx | Out of scope | Owner D14: changes existing kinds' behaviour; separate ticket |
| Antigravity's missing `HARNESS_TEMPLATES` entry | Out of scope | Owner (grill defaults #13): pre-existing gap in another kind |
| Gemini/antigravity capability-discovery gaps in `commands.ts` | Out of scope | Pre-existing, documented in code; another kind |
| `archiveTask` doesn't clear `antigravityTurnQueue` (delete and switch do) | Out of scope | Pre-existing gap in another kind, found by T8 during execution; the copilot queue is cleared on archive |
| Copilot commit trailer / auto-update flags | None by decision | Owner D19 |
| `--disable-builtin-mcps` | None by decision | Owner D25 (built-in GitHub MCP stays on) |
| Renumbering the migration at merge | In this run, at merge time | §3.11 rule; whoever merges second |

## 10. Execution record (2026-10-27)

- **Commits:** `82d670c` (plan docs), `5972205` (wave 1), `3c82ee5` (wave 2), `6471e96` (wave 3), `4b76907` (test-isolation fix).
- **Verification:** `bun run typecheck` green. Full `bun test`: 8706 pass. The only failures were two copilot reconcile tests that hit the `AGETOR_TMUX_BIN=/bin/echo` cross-file leak (fixed in `4b76907`) and the `at-file-filter` perf test at load average 36 (it passes alone). TT8 (real copilot 1.0.104, BYOK): 10/10. Full e2e: 333 passed; 5 load flakes at load average ~106 all passed on re-run (35/35, incl. the 21 that did not run). `e2e/copilot-harness.spec.ts`: 6/6, twice.
- **Driver checked against the spike's real JSONL:** the `result` event carries `exitCode`/`sessionId` at the top level (no `data`, no `id`). This is fixed and pinned by a regression test.
- **A9 resolved:** a `/skill` prompt works in `-p`, and Copilot injects the skill body, so skill inserts stay `/name`.
- **A10 resolved (BYOK):** `assistant.reasoning` reaches stdout and maps to `thinking`.
- **Read-only, refined:** Copilot still auto-approves read-only shell commands; only edits and file-changing commands are denied. The mode copy was updated.
- **A7:** no effort-unsupported notice was observed (BYOK `gpt-5.4` accepted `high`).
- **Wave 5 (live smoke): not run.** By owner decision, Copilot CLI is not installed on this machine. Still unverified against a real login: the AI-credit conversion (A4 — `aiCredits` stays flagged unverified and is to be removed if a later smoke can't confirm it), `exit_plan_mode.requested`/plan.md in `-p` (A3), and `COPILOT_HOME` login isolation (A5). T17 did not run.
