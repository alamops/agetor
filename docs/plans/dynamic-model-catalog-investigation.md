# Investigation — dynamic model & effort catalog per harness

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Change | Stop hand-adding each new model (and its effort ladder) per release: read models + per-model efforts from each harness's own CLI at runtime, keep older CLIs working through the curated tables as a fallback. Informs the grill and the plan: which harnesses can be made dynamic, through which probe, and what the curated layer still has to own. |
| Agents | none (pipeline step forbade sub-agents) — inline codebase + git-history read, web research, 6 live spikes in the scratchpad |
| Flags | none |

## 0. Contract

The only statement of the goal is the pipeline task text ("Currently we're kinda manually adding support for models in the list for most of the harnesses … a dynamic way for picking the models and their efforts automatically from the harnesses … We still have to support older version"). It lives **outside the repo** (the agetor task prompt). The plan should copy the goal into `docs/plans/dynamic-model-catalog.md` so a reviewer can check against it.

## 1. What we know

### 1.1 The cost of the status quo (git history)

A typical "add model X" PR touches 15–26 files. Examples:

| PR | Files | Of which |
| --- | --- | --- |
| #296 Fable 5.2 / Mythos 5.2 | 26 | `types.ts` (+78), `agents.ts`, migration 086, `orchestrator.ts` comments, `fx-acp.ts`/`agent-discovery.ts` comments, 7 test files, grill json |
| #278 GPT-6.1 Terra + 9 fx + 3 cursor families | 22 | `types.ts` (+142), migrations 075/076, catalog test (+262), `migrate.test.ts` (+414) |
| #270 Gemini 4 Argon | 23 | `types.ts` (+117), migrations 064/065/066 |
| #265 Haiku 5.5 / #238 Grok 4.7 | 15–16 | `types.ts`, a cursor normalization migration each |

`git log` shows 20 such feature PRs since #82 (Sonnet 5), plus 26 `docs/plans/add-*`/`*-compat.md` plans. 11 migrations exist only to normalize or retire model ids (049, 055, 056, 060, 062, 064, 065, 066, 074, 075, 076, 086). Eight of them are cursor "fold discovered variant ids into base + effort" passes.

### 1.2 Where model knowledge is hard-coded today

All in `src/shared/types.ts` unless noted:

- `AGENT_OPTIONS[kind].models` (`types.ts:4797`): curated rows with label, hint and `catalogOnly`/`pinned`. Today: claude-code 16, codex 12, gemini 6, fx 43 (27 `catalogOnly`), antigravity 18 (effort baked into the id), copilot 14, opencode 1 (the pinned sentinel). Cursor's rows are derived from `CURSOR_MODEL_SPECS`.
- `DEFAULT_MODEL` (`types.ts:3445`): a per-kind owner pick, often deliberately not the CLI's own default. fx, copilot and gemini are documented exemptions.
- `DEFAULT_EFFORT` (`types.ts:3530`): per kind, not per model.
- `MODEL_EFFORT_SUPPORT` (`types.ts:4237`): per model, for every kind.
- `MODEL_MODE_DENY` (`types.ts:~4730`): per claude model. Every entry is empty, and it must still list each new claude id.
- `MODEL_MIN_CLI_VERSION` (`types.ts:3595`): codex (6 ids) and copilot (9 ids).
- `CURSOR_MODEL_SPECS` (`types.ts:3621`): 44 bases with `effortIds`, `fastEfforts`, `fastId` and `supportsMaxMode`. `cursorModelArg` composes the argv/ACP value from them (`types.ts:4094`).
- `EFFORT_OPTIONS` (`types.ts:4204`): a closed set of 9 ids, with hint copy naming models.
- `src/bun/agents.ts:252`: `CLAUDE_MODEL_FLAG`, a friendly id → CLI id map (16 rows). Also `claudeModelPickerFamily` (`agents.ts:345`, a hand switch of "which id owns the Opus/Sonnet/Fable/Haiku picker row"), `claudeModelIdFromArg`, and `CLAUDE_EFFORT_VALUES` (`agents.ts:372`, a closed set: unknown effort ids are dropped).
- `src/bun/claude-local-setting.ts:69`: `claudeModelIdFromDisplayName` maps claude's `/model` display names back to curated ids by matching `AGENT_OPTIONS` labels.
- `NewTaskForm.tsx:1143`: a family check for the "Fable bills 2x" notice (already id-agnostic).
- The duplicated cursor "covered by catalog" filter: `NewTaskForm.tsx:440`, `RunPanel.tsx:9086`, `TaskLaunchPickers.tsx:431,470`, `cli/commands/add.ts:846`.

Rule from `docs/architecture/harnesses.md:48,57` (the add-a-kind checklist): items 1 and 6 enumerate these tables, and `agent-discovery.ts` (with `model-discovery.ts` `PER_HARNESS_KINDS`, applied only to account-scoped catalogs).

### 1.3 What already exists (dynamic layer)

Discovery is real and wired end to end. It is per kind, and per harness for fx/codex/opencode.

- Probes: `src/bun/agent-discovery.ts`. Cache: in-memory only (`cache`, `harnessCache`). Readiness: `isDiscoveryReady`.
- Scheduler: `src/bun/model-discovery.ts`. Triggers: boot, harness status transitions, harness CRUD, `POST /agent-models`, and a 15-minute sweep. It broadcasts the `agent_models_changed` AppEvent. It was introduced by #198; the root cause and fix are captured in JubarteAI entry e99fea15.
- Merge: `src/shared/model-options.ts` `mergeModelOptions`, with 9 documented rules: curated-first, catalog-scoped filtering, `catalogOnly`, `pinned`, selected-unlisted, logged-out distrust, efforts and speed flags copied from discovery.
- Efforts: `supportedEfforts(agent, model, discoveredEfforts)` (`types.ts:4620`). A non-empty discovered set wins, filtered to `EFFORT_OPTIONS` ids. Otherwise the curated table applies. An unknown model falls back to `DEFAULT_MODEL`'s set; an unknown cursor id gets `[]`. `retainableEfforts` (`types.ts:4702`) is the union of discovered and curated, so a model change never silently drops a chosen effort. That contract is decision 785c5209 (GPT-6 Astra, #210).
- Status per kind:

| Kind | Probe today | Ids | Labels | Efforts | Speed | Scope |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | **none** (`discoverClaude` returns `[]`, `agent-discovery.ts:465`, "no programmatic model-list command") | — | — | curated | — | — |
| codex | `codex app-server` JSON-RPC `model/list` (`agent-discovery.ts:281`) | ✓ | ✓ | ✓ (`supportedReasoningEfforts`) | ignored | per harness (CODEX_HOME) |
| cursor | `cursor-agent --list-models`, loose line parser (`:152`) | flat variant ids | dropped | via `CURSOR_MODEL_SPECS` only | via specs | kind |
| gemini | **none** (`:475`, "no model-list command", checked on 0.54.0) | — | — | none (no per-invocation effort flag) | — | — |
| fx | `fx models --json` (`:590`) | ✓ | ✓ | ✓ (≥0.0.14) | ✓ fast/ultrafast | per harness, `CATALOG_SCOPED` |
| antigravity | `agy models` text (`:502`) | ✓ (effort in id) | ✓ | baked in id | — | kind |
| opencode | v2 `models --standalone` + `api --standalone model.list`; v1 `models --verbose` (`:1072`) | ✓ | ✓ | ✓ variants | — | per harness, `CATALOG_SCOPED` |
| copilot | `copilot help config` (`:1371`), offline | ✓ ids only | — | curated | — | kind (static per binary) |

OpenCode is already fully dynamic: it has no curated rows except the pinned sentinel, a version-gated v1/v2 probe, and synthesized effort rows for unknown variants (`opencodeEfforts`, `types.ts:~4680`). That makes it the in-repo precedent for "dynamic + older versions".

### 1.4 Live facts — installed CLIs (read-only probes, 2026-11-17)

`claude 2.1.326`, `codex-cli 0.166.0`, `cursor-agent 2026.10.22-27dcf5f`, `fx 0.0.15`, `opencode v2.1.3`. Not installed on this machine: `gemini`, `agy`, `copilot` (their facts below come from web sources only).

### 1.5 Standards that apply (repo rules)

- Every spawn goes through `coreSpawn` with `childEnv` (CLAUDE.md "Security and process boundaries"). Probes run a binary from an agent-plantable PATH.
- Any new route needs a `ROUTE_POLICY` entry (`route-policy.ts`). `/agent-models*` are existing routes.
- No new SSE stream (the WKWebView connection budget). Reuse `agent_models_changed`.
- No long synchronous loops on the Bun main thread (`core-responsiveness.md`). Probes are async; parsing is small.
- CLI/TUI output of third-party data goes through `src/shared/terminal-text.ts` (`escapeControlChars` for ids, `escapeFreeText` for labels).
- `src/shared/` stays free of runtime imports. `model-options.ts` is structural on purpose.
- Server-managed columns, `PATCH` allow-list, migrations append-only and never edited (`persistence.md`).
- The PATCH effort guard is null-clear only and never rejects a non-null effort (decision 785c5209 rule 4).
- Tests that import `db.ts` use a top-level `mkdtemp` data dir and `snapshotHarnessState`.
- Memory/feedback: no real ticket ids, account names or emails in code or fixtures. The claude `initialize` response carries the account email and org (see §2), and they must never be logged or persisted.

### 1.6 Runtime & trust shape

- One Bun core process: the desktop app, or the headless/login-item core, owns discovery. No second instance runs probes concurrently (the port bind is the ownership claim). Webview and CLI read through `GET /agent-models`, `GET /agent-models/harnesses` and `POST /agent-models`.
- Probe inputs are third-party CLI output: ids, labels and descriptions rendered in the webview (React-escaped) and in the CLI (must be escaped). Cursor labels carry literal zero-width spaces (`Grok 4.7  Low Fast​​` in the `cursor-agent models` output), so labels need sanitizing.
- Probes run under the user's credentials. For claude, the `initialize` response includes `account.email`, `account.organization` and `subscriptionType` (redacted in the spike output).

## 2. What we proved (spikes, all in the scratchpad, re-runnable)

Scratchpad root: `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-08117ed9-d3bc-4976-b94b-698de8ec18c2/e5834b62-43a5-4df8-b9ec-dc9a314798c8/scratchpad`. Scripts are in `scripts/`, outputs in `spikes/<name>/`.

| # | Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- | --- |
| S1 | Can claude report its model list + per-model efforts programmatically, without spending quota? | **Yes** | `claude -p --input-format stream-json --output-format stream-json --verbose --settings '{"disableAllHooks":true}' --no-session-persistence`, then one stdin line `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}`. The `control_response.response.models[]` has 14 entries: `{value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels[], supportsAdaptiveThinking, supportsFastMode, supportsAutoMode, supportsThinkingOff}`. ~1.7 s wall, no prompt sent, no `~/.claude/projects/<cwd>` dir created. | 2.1.321 and 2.1.326: identical lists | `scripts/claude-init.ts`, `spikes/claude-init/out.json` (+`out-321.json`) |
| S1b | Is claude's list account-scoped? | **Yes (partly)** | The owner's account (Claude Ultra, firstParty) gets no Mythos rows, though the binary and curated table know `mythos-5.x`. The capability fields arrived in **2.1.49** (Feb 2026, per the release notes and the docs issue). Older CLIs return `{value, displayName, description}` only, so efforts fall back to the curated table. | — | web: see Sources |
| S1c | Do claude's ids match agetor's? | **No** | Current-family rows use aliases (`value: "opus"`, `"fable"`, `"sonnet"`, `"haiku"`, plus `"default"`) with `resolvedModel: claude-opus-5-5` etc. Older rows use full ids (`claude-opus-5`, `claude-haiku-4-5-20251001`, dated). Agetor ids are `opus-5.5`, `haiku-4.5`… via `CLAUDE_MODEL_FLAG`. | 2.1.326 | `out.json` |
| S1d | Is the curated claude effort table right? | **No — drift found** | CLI: `claude-opus-4-6` → `low,medium,high,max` (no xhigh). Curated `MODEL_EFFORT_SUPPORT["claude-code"]["opus-4.6"]` offers `max,xhigh,high,medium,low`, so agetor offers xhigh on Opus 4.6. Every other claude row matches. | 2.1.326 | `scripts/naive-claude-merge.ts` |
| S2 | **Would the tests notice a naive claude discovery?** | **No — they'd stay green while the picker doubles** | Feeding S1's models into today's `mergeModelOptions` (claude is unscoped, rule 4) gives **30 rows for 16 curated** when ids = `value`, and **29** when ids = `resolvedModel`. 12–13 labels are duplicated ("Opus 5.5" twice, …). No test covers claude discovery or cross-alias uniqueness. | repo HEAD 32aa7c3a | `scripts/naive-claude-merge.ts` |
| S3 | Codex `model/list` shape on the current CLI | **Richer than agetor reads** | 10 entries (2 `hidden`). Per model: `isDefault` (gpt-6.1-sol), `defaultReasoningEffort`, `supportedReasoningEfforts`, `additionalSpeedTiers:["fast"]`, `serviceTiers[{id:"priority",name:"Fast"}]`, `defaultServiceTier`, `upgrade`/`upgradeInfo`, `availabilityNux`, `inputModalities`. Agetor reads only id, displayName, efforts and hidden. The catalog is client-version-gated (`MODEL_MIN_CLI_VERSION` comment), so an old CLI simply doesn't list a new model. | codex-cli 0.166.0 | `scripts/codex-models.ts`, `spikes/codex/models.json` |
| S4 | Cursor: is there a structured model + effort source? | **Yes, but probing it mutates the user's global cursor config** | (a) `cursor-agent models` and `--list-models` (both exist; side-effect free) print 284 flat `id - Label` lines with an irregular suffix grammar (`-thinking-`, `-fast`, base default variants with no suffix, `cursor-grok-4.5-*` vs ACP base `grok-4.5`, `claude-4.6-sonnet-medium-thinking`). (b) `cursor-agent acp` `session/new` returns ACP `configOptions` (`mode`, `model`, 48 base models) plus `models.availableModels`. (c) With `clientCapabilities._meta.parameterizedModelPicker: true`, `session/set_config_option {configId:"model"}` returns per-model parameter selects: effort under 3 different ids (`effort`/`reasoning`/`reasoning_effort`, category `thought_level`, values incl. `extra-high`, `minimal`, `none`), `thinking` bool, `context`, `fast`. Enumerating all 48 took **52 s**, and **each set persisted to `~/.cursor/cli-config.json`** (`model`, `selectedModel`, `modelSelectionHistory`, `modelParameters`). | 2026.10.22-27dcf5f | `scripts/acp-session.ts`, `scripts/cursor-param.ts`, `spikes/cursor/{models.txt,acp-new.json,param-models.json}` |
| S4b | Side effect cleanup | Restored | The spike changed the owner's cursor default model. It was restored via ACP to the pre-spike value, `composer-2.5` + `fast=true` (read before any set). `modelSelectionHistory` keeps the spike's recent picks. | — | `scripts/cursor-restore.ts` |
| S5 | fx 0.0.15 `models --json` | Unchanged since 0.0.14 | 136 ids on the owner's signed-in account. `models[]` = `{id, name, efforts[], fast, ultrafast}`. No default flag. | fx 0.0.15 | `spikes/fx/models.json` |
| S6 | OpenCode v2 discovery inputs | Matches the code | `opencode models --verbose` is rejected on v2 (prints help, exit 1), which is why `discoverOpencode` uses `models --standalone` + `api --standalone model.list` on v2 and `--verbose` on v1 only. | opencode v2.1.3 | — |

Web facts (not spikeable here):

- **Gemini CLI ≥ 0.67.0** (2026-11-04, PR google-gemini/gemini-cli#29880) adds `gemini models` / `gemini models list` / `gemini --list-models` and `-o json`. The JSON fields are `modelId, id, name, displayName, description, contextLimits{inputTokens,outputTokens}`, with **no thinking levels**. It skips auth refresh. Older Gemini CLIs have no listing, which the current `[]` handles.
- **ACP session config options** (agentclientprotocol.com) standardize categories `model`, `thought_level`, `model_config`, `mode`. `set_config_option` must return the full option list. Cursor implements it. fx exposes its `effort` option per session. Copilot and Gemini ACP behavior is unverified (not installed).
- **Copilot CLI**: an ACP server exists (public preview). `--effort`/`--reasoning-effort` takes `low..max` (1.0.80 help reportedly also lists `none`, `minimal`). No documented non-interactive model+effort listing beyond `help config` (ids only).

## 3. What we're assuming

1. **The claude `initialize` probe is safe to run from the core**, with `--settings '{"disableAllHooks":true}'`, `--no-session-persistence` and a neutral cwd, and probably `--strict-mcp-config` so the user's MCP servers aren't started. If MCP servers or SessionStart hooks do start, or `~/.claude.json` counters change meaningfully, the probe needs stronger isolation, or claude stays curated. MCP start-up during `initialize` is **unverified**.
2. **The probe consumes no quota.** No message is sent, so nothing is billed. If Anthropic ever meters `-p` sessions on subscription accounts at init, the probe must change.
3. **The `initialize` response stays stable across claude releases.** It is the Agent SDK's `supportedModels()` contract, so it is semi-public. If it changes, older-CLI fallback (curated) covers it, the same as a probe failure.
4. **Claude's list is per account (`CLAUDE_CONFIG_DIR`)**, as Mythos gating suggests. That means claude would join `PER_HARNESS_KINDS` for harness stacks. If it is actually kind-level, one probe suffices.
5. **Cursor's 284-id flat list can be grouped into base + effort + fast reliably enough by heuristics.** If not, cursor needs either the ACP parameterized probe run in isolation (which needs an isolated config without losing auth, unproven) or stays spec-driven.
6. **Old CLIs keep working because every probe failure degrades to today's curated behavior** (`mergeModelOptions` rule 2, `supportedEfforts`' curated fallback). That holds as long as the curated tables are kept, not deleted.

## 4. What we must ask the owner

1. **Scope: which harnesses?** Claude (new probe, biggest win), cursor (hardest), gemini (≥0.67 ids only), copilot (ids only, efforts curated), codex/fx/opencode (already dynamic, extend only). Is "all eight, best effort per CLI" the target?
2. **What happens to the curated tables?** Options: (a) keep them as the fallback for old or offline CLIs plus curated labels and hints, with discovery appending; (b) shrink them to a "floor" (a few known-good rows per kind) and let discovery own the rest; (c) delete them where discovery is reliable. S2 shows (a) needs id unification, or the picker doubles.
3. **Claude id scheme.** Keep agetor's friendly ids (`opus-5.5`) and map CLI ids to them dynamically (derive `opus-5.5` from `claude-opus-5-5`)? Or switch new rows to the CLI's own ids (`claude-opus-6`), keeping the friendly ids only for legacy rows? The second avoids a mapping table but leaves mixed ids. A migration of stored `tasks.model`, `agent_profiles`, `lastModel:claude-code`, bundles and frozen snapshots is the expensive path. Note also that claude's `value` is an alias (`opus`) for the newest of each family. Should a dynamic "Opus (latest)" alias row exist, auto-tracking new releases with no agetor change at all?
4. **Default model and default effort: dynamic or owner-picked?** Codex reports `isDefault`, claude reports `default → claude-opus-5-5`, codex reports `defaultReasoningEffort`. The repo has many deliberate departures from the CLI default (fx deepseek, gemini not `auto`, cursor grok-4.7 vs cursor's composer-2.5, copilot `auto`). Follow the CLI by default, with owner overrides?
5. **Unknown effort ids.** `EFFORT_OPTIONS` is a closed set. A new level (e.g. codex `ultra` in #210, cursor `extra-high`) is dropped by `supportedEfforts` and by `CLAUDE_EFFORT_VALUES` at spawn. Should unknown discovered levels get synthesized rows the way OpenCode does (`{id, label:id}`) and pass through to the CLI?
6. **Curated hints/labels/ordering for new models.** Pricing and "2x usage" copy can't be discovered. Is the CLI's own `displayName`/`description` acceptable for discovered rows, and is CLI order the picker order?
7. **Cursor strategy.** (a) Parse the flat `cursor-agent models` list into families (side-effect free, heuristic, 1 call). (b) ACP parameterized probe (exact, 52 s, **writes the user's `~/.cursor/cli-config.json`**). (c) Keep `CURSOR_MODEL_SPECS` and only stop requiring migrations. Also: should the driver switch to the parameterized model value (`base[effort=…,fast=…]`, which `--help` documents) instead of flat variant ids? That would make `cursorModelArg` table-free, but param names vary per model (`effort`/`reasoning`/`reasoning_effort`). Fleet evidence (JubarteAI 421157fb, cursor-agent 2026.09.26 `-p` probe matrix) found bracket values rejected for several models (Sonnet 5.5, Sonnet 5, and any fast-capable model without `fast=`). Whether ACP's parameterized picker (`set_config_option` per parameter, not a bracket string) avoids that is **unverified**, and each run probe is a paid request.
8. **Speed/fast tiers.** Claude reports `supportsFastMode`; codex reports `additionalSpeedTiers:["fast"]`/`serviceTiers`. Today only cursor and fx have Speed. In scope, or a follow-up?
9. **Minimum-CLI-version floors.** Codex's catalog is client-version-gated, so a discovered list implies the model runs on the installed CLI. Can `MODEL_MIN_CLI_VERSION` be retired for kinds whose discovery is authoritative, keeping it only as the fallback when discovery is empty?
10. **Persist the last discovered catalog?** It's in-memory today, so a cold boot or offline start shows curated-only until the sweep lands. Persisting (preferences table or a new table) would make "dynamic" rows survive restarts and offline. One-way-door: a migration.
11. **Pre-existing bug found on the way:** curated Opus 4.6 offers `xhigh`, which claude says it doesn't support. Fix it here, or let discovery override it?
12. **Pre-existing side effect worth confirming:** agetor's cursor driver calls ACP `session/set_config_option {configId:"model"}` every turn (`cursor-acp.ts:789`). In parameterized mode that persists to `~/.cursor/cli-config.json`. Agetor uses the default "variants" mode, where it may write `acp-config.json` `selectedModelVariantId` instead (**unverified**). Does the owner care that agetor runs may change their interactive cursor default?

## 5. Completeness inventory

- **Callers of the catalog symbols** (non-test; counts from `grep`): `src/shared/types.ts` (40), `src/bun/orchestrator.ts` (33: `createTask` effort defaults, `effortFallbackForModelChange`, `minCliVersionError` ~`:8898`, `reconcileTaskSession` model mirror ~`:5558`), `NewTaskForm.tsx` (15), `RunPanel.tsx` (11), `TaskLaunchPickers.tsx` (10), `src/cli/commands/add.ts` (8), `agent-discovery.ts` (7), `agents.ts` (5), `model-options.ts` (4), `harness-failover.ts` (4, CLI floor at `:253`), `server.ts` (3, PATCH guard + `/agent-models*`), `claude-local-setting.ts` (3), `mainview/lib/stack-badge.ts` (2), `shared/cli-version.ts`, `shared/bundle.ts`, `shared/bundle-import.ts` (`knownModels`), `cli/stack-display.ts`, `cli/commands/show.ts`, `bun/fx-acp.ts`, `bun/bundle.ts` (1 each).
- **Entry points new code wires into:** `discoverClaude` and the `runRefresh` probe list plus its index-aligned `kinds` array, the `runRefreshKind` switch, `discoverHarnessKind`/`HarnessTarget.kind` (if claude becomes per-harness), `model-discovery.ts` `PER_HARNESS_KINDS`, `__testing` exports, `GET /agent-models*` in `server.ts` (existing `ROUTE_POLICY` entries), and the `agent_models_changed` AppEvent.
- **Propagation surface:** `DiscoveredModel` (bun) ↔ `DiscoveredModel`/`ModelOption` (shared, structural twin), `supportedEfforts`/`retainableEfforts`/`discoveredEffortsFor`/`getDiscoveredEfforts`, `supportedSpeeds` (`src/shared/speed.ts`), `cursorModelArg`/`cursorModelSupportsFast`/`cursorModelIdCoveredByCatalog`, `toClaudeModelArg`/`claudeModelIdFromArg`/`claudeModelPickerFamily`/`claudeModelIdFromDisplayName`, `CLAUDE_EFFORT_VALUES`, the `buildCommand` effort branches (`agents.ts:778` claude env, `:1071` copilot, `:1113` codex), `AgentOption.catalogOnly`/`pinned`, `CATALOG_SCOPED_KINDS`, `MODEL_DEFAULT_EFFORT_KINDS`, the bundle export/import model checks, the CLI `agetor add --model/--effort` validation, and the TUI.
- **Existing data a migration might touch:** `tasks.model`/`effort`/`speed`, `agent_profiles` model fields, frozen `tasks.agent_profile`/`tasks.pipeline_run` JSON snapshots (never rewritten by convention), `preferences` `lastModel:<kind>`/`lastEffort:<kind>`, and exported bundles. Volumes are unknown; read-only sqlite against `~/.agetor-dev` if needed (memory: prod DB forensics).
- **Docs to update:** `docs/architecture/harnesses.md` (checklist items 1 and 6), `harness-claude-code.md`, `harness-cursor.md`, `harness-codex.md`, `harness-gemini.md`, `harness-copilot.md`, `CLAUDE.md` "Agent kinds at a glance" (if a probe changes), `README.md` model mentions.
- **Tests pinning curated content:** 16 test files reference `AGENT_OPTIONS`/`MODEL_EFFORT_SUPPORT`/`CURSOR_MODEL_SPECS`, among them `src/shared/{fable-5-2,gemini-4-argon,gpt-6-1-terra}-catalog.test.ts`, `types.test.ts`, `src/bun/effort-support.test.ts`, `agents.test.ts`, `migrate.test.ts`, `claude-local-setting.test.ts`, `agent-discovery.test.ts`, and e2e `fx-models.spec.ts`, `speed-picker.spec.ts`.
- **Would orphan (if discovery replaces curated content):** most of `MODEL_MODE_DENY`'s claude rows (all empty), `CLAUDE_MODEL_FLAG` rows, `claudeModelPickerFamily`'s hand switch (derivable from claude's alias rows), the per-release catalog tests, the cursor normalization migration pattern, and `MODEL_MIN_CLI_VERSION` entries (see Q9).

## 6. Runnability

- Start locally: `bun install`, then `bun run dev:hmr` (Vite + Electrobun, data in `~/.agetor-dev`). Headless smoke: core on :4319 with `~/.agetor-dev`, then curl `GET /agent-models` and `/agent-models/harnesses` with the token from `<dataDir>/agetor-core.json`. Worktree PATH: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- Tests: `bun run typecheck`, `bun test` (or a single file, e.g. `bun test src/shared/model-options.test.ts`). Discovery probes have seams: `__testing.setCodexProbeTimeoutMs`, `setOpencodeProbeTimeouts`, `AGETOR_<KIND>_BIN` stubs (fake bins under `/tmp` via `fakeBinDir` because of TMPDIR bloat).
- E2E: Playwright, `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts`. The stub fx answers `models --json` from `AGETOR_E2E_FX_MODELS_JSON` (`e2e/fixtures.ts:115-138`). New kinds' discovery would need the same stub-file seam (a claude stub answering the `initialize` control request, a cursor stub answering `models`).

## 7. Risks & blast radius

- **Picker duplication** (S2) if ids aren't unified. That's user-visible immediately and not caught by today's tests.
- **Stored-effort silent changes**: discovered sets narrowing the picker must not PATCH away a stored effort. `retainableEfforts` already guards the cascades, and any new path must use it.
- **Probe side effects**: cursor ACP enumeration writes the user's global config (S4). The claude probe could start MCP servers or hooks if not isolated (assumption 1). Codex `app-server` writes `~/.codex/models_cache.json` (already accepted).
- **Probe cost**: claude ~1.7 s per account, codex ≤5 s, opencode ≤8 s, cursor flat list ~1–3 s (ACP enumeration 52 s, unacceptable on the 15-minute sweep without care). All run off the main-thread hot path via the FIFO `enqueue`.
- **Account data leakage**: claude's `initialize` carries the email and org. A parser must whitelist `models` and drop the rest, and never log raw output.
- **Older CLIs**: claude < 2.1.49 (no efforts), gemini < 0.67 (no list), fx ≤ 0.0.13 (no efforts), opencode v1 vs v2, codex old (`model/list` absent → `[]`). Every path must degrade to curated.
- **Harness stacks / failover**: `harness-failover.ts:253` checks CLI floors on swap. A dynamic per-account catalog changes which models a backup account can run (Mythos on one account, not another).
- **Bundles/profiles**: `bundle-import.ts` warns on unknown models via `knownModels`. With dynamic catalogs, "known" depends on the importing machine's discovery.

## Sources

- [Claude Code v2.1.49 release notes](https://newreleases.io/project/github/anthropics/claude-code/release/v2.1.49): `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking` added to the SDK model info
- [Agent SDK `ModelInfo` docs issue #27020](https://claudeissues.com/issue/27020-docs-agent-sdk-typescript-modelinfo-type-missing-capability-fields-added-in-2-1)
- [ClaudeCode.Model.Info (Elixir wrapper)](https://hexdocs.pm/claude_code/ClaudeCode.Model.Info.html): fields come from the CLI initialization response
- [gemini-cli PR #29880](https://github.com/google-gemini/gemini-cli/pull/29880) and the [v0.67.0 release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.67.0)
- [ACP session config options](https://agentclientprotocol.com/protocol/session-config-options)
- [Copilot CLI ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
