# Plan — Add OpenCode harness

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | Pipeline "Alamo Pipeline (No Video)" step 3. Inputs: `docs/plans/add-opencode-harness-investigation.md` (step 1), `docs/plans/add-opencode-harness-grill.md` (step 2), and a read-only grounding pass over `main` @ `c5cf1a2` (anchors below) |
| Flags | none |
| Gates | grilled + approved by owner (2026-10-27; plan-approval answers: claude-code joins the resume fix, the toast covers fresh installs too, one shared launch-scan toggle) |
| Branch | `feature/add-opencode-harness` (already cut) |
| Base SHA | `c5cf1a2d431f2891506a26010695289a1b6c46ae` (tree clean apart from the three plan docs) |

Grill decisions are cited as **G#** (e.g. G3a) and accepted defaults as **GD#** (e.g. GD4). Investigation sections are cited as **I§**.

---

## 1. Objective & success criteria

Add OpenCode (`anomalyco/opencode`, binary `opencode`) as a new agent kind `opencode`, wired into every place a kind lives today, together with the cross-kind changes the owner pulled into scope.

Done means all of the following hold:

1. **Running a task.** An `opencode` task runs as a tmux-hosted one-shot `opencode run --format json` per turn, on both OpenCode lines: v1 (`opencode-ai` 1.x) and v2 (`@opencode/cli` / Homebrew 2.x). The prompt goes in on stdin. Flags are chosen from the probed `--version` (G1). A follow-up message resumes the same session with `-s <id>`. Stop, delete, archive and agent-switch all behave as G3b and GD7 specify. A turn that is in flight survives an agetor restart (boot reattach).
2. **Picker options.**
   - The model picker shows **"OpenCode default"** (no `-m`) plus each harness's discovered models (G4).
   - The effort picker shows "Model default" plus that model's discovered variants (G5).
   - Modes are Auto and Plan (G6).
   - The per-task **OpenCode server** option (Shared / Standalone) appears everywhere launch settings live. Its default is Shared; it is locked to Standalone for harnesses with a home, and hidden on v1 (G3–G3c).
3. **Parity features.**
   - Transcripts render assistant text, thinking (`--thinking`), tool cards, the TODO tracker (`todowrite`) and the run-row usage chip (G10).
   - Subagent tabs fill when a child finishes (G12).
   - A new session gets the task title (G13).
   - Skills, commands and MCP servers are discovered (G7).
   - A non-blocking "no credentials" hint is shown (G9).
4. **Cross-kind changes.**
   - Built-in codex, cursor, gemini, fx and opencode harnesses turn on **once** when their CLI is first found installed. A later manual Off sticks, and the user gets a one-time toast (G8, G8a).
   - Every one-shot kind, and claude-code too (owner, at plan approval), resumes only a session the **same harness** created (G11).
5. **Import.** OpenCode sessions started outside agetor can be listed and imported under the Claude import rules (G14, G14a).
6. **Tests.** `bun run typecheck` is green, and so is `bun test` (apart from the three failures already on `main` — memory "pre-existing failing unit tests"). The new and touched e2e specs are green, and so is the full e2e suite, run once.
7. **Live check.** A live smoke on a real v2 binary and a real v1 binary passes, or is recorded as open if no keyless Zen model can run a turn (G16).

## 2. Context & constraints

### 2a. How a kind is wired today (Antigravity is the template)

- **The union.** `src/shared/types.ts:296` (`AgentKind`). Adding a member breaks `tsc` at only **21 sites in 9 files** (KB `785913e5`, spike on `c5cf1a2`). Three dispatch points fall through **silently** when a kind is missing:
  - `buildCommand`/`spawnAgent` fall through to **codex** (`src/bun/agents.ts:479`, `:3123`, trailing codex code at `:3296`).
  - `harnessEnv` falls through to `GEMINI_CLI_HOME` (`agents.ts:376–390`).
  - `onSessionId` falls through to `fxSessionId` (`src/bun/orchestrator.ts:1790–1800`).
  `CLAUDE.md:102`'s "the orchestrator and UI pick it up automatically" is false (KB `805945c6`).
- **Type-checked tables** in `types.ts`: `DEFAULT_MODEL` :2511, `DEFAULT_EFFORT` :2584, `CODE_PLAN_MODE` :3099, `MODEL_EFFORT_SUPPORT` :3186, `MODEL_MODE_DENY` :3537, `AGENT_OPTIONS` :3597. Plus `INSTALL_HINTS` (`src/bun/agent-status.ts:17`), `AgentIcon` (`src/mainview/components/kanban/AgentIcon.tsx:8`), `HARNESS_HOME_COPY` (`SettingsDialog.tsx:182–206`), `resolveBin` (`agents.ts:300`), `runRefreshKind` (`src/bun/agent-discovery.ts:1112`), and the map indexing in `NewTaskForm.tsx:307`, `TaskLaunchPickers.tsx:185`, `App.tsx:246`, `api.ts:212`.
- **Hand-edited kind lists** (not type-checked):
  - `db.ts:1809–1825` (`getByIdOrKind`), `:1840–1844` (insert validator), runs row type/mapper/INSERT/UPDATE `:2571/:2666/:2710–2723`.
  - `server.ts:3931–3938` (`POST /harnesses` validator + error text), `:4905/:4940` (agent-models maps).
  - `agent-discovery.ts:975–983` (the `allSettled` list plus an **index-aligned** `kinds` array).
  - `model-discovery.ts:62/96/172` (per-harness gates are fx/codex only).
  - `SettingsDialog.tsx:145` and `:1908`, `NewTaskForm.tsx:989–995`, `OnboardingChecklist.tsx:40/172–178`, `e2e/fixtures.ts:330–375`.
  - `commands.ts:165/324–390/703–770`.
  - Orchestrator sites, listed under 2b.
- **One-shot driver template.** `src/bun/antigravity-tmux.ts` (548 lines):
  - log/prompt/exit paths `:44–73`, mapper `:144`, tailer `:339`, launch `:426–490`.
  - The shell wrapper `"$@" "$(cat <prompt>)" > <log> 2>&1; echo $? > <exit>` (`:439`), with surfaced `spawnTmuxNewSession` failures (fix `80c015f`).
  - Reattach `:506`, drop `:541`.
  Codex's stdin redirect (`codex-tmux.ts:479`) is the other half of what OpenCode needs.

### 2b. Orchestrator (7,741 lines)

- **Imports** :117–119.
- **Reconcile and reattach:** the `SELECT` :797–798 (lists every `*_session_id` column), the kind/key ternary :808–840, reattach dispatch :892.
- **Run row:** `runs.insert` session-id defaults at :1757, :3960, :4161, :4340, :4927, :5803, :6063, :6164. `Run.antigravitySessionId` is **optional** (`types.ts:3951`), and the new column copies that precedent, so these sites need no edit. The `onSessionId` mapping is at :1799.
- **Turn queues and agent switch:** queue drains :2682/:2725; agent-switch teardown and queue clear :2769–2790. The `tasks.update` at :2790 resets `mode/model/effort/speed/maxMode`.
- **Sending:** `sendInput` dispatch :3747. The antigravity queue/turn/drain/findLast block (:4448–4598) is the pattern.
- **Archive and delete:** archive teardown :6826; delete queue clear :7173 and teardown :7198.
- **`findLast*SessionId`:** codex :4078, cursor :4258, gemini :4437, antigravity :4591, fx :5061 (also gating `resumeFxRecovery` :5458), claude :6272. Each selects the newest non-null id with **no harness filter** (KB `e100e031`). `resolveHarness` is at :58.
- **Agent profiles:** the freeze compares six fields, :1533–1542 (`driftedFromRow`). `createTask` takes defaults at :6678. Profile-bound PATCH fields are at `server.ts:5213`. `ALLOWED_PATCH_FIELDS` is at `server.ts:477–497`, and the launch-field parser at `server.ts:1013–1065`.
- **Imported sessions:** the start refusal is at :1477 (`code: "imported-session"`), the send refusal at :3569–3581.
- **Background-agent hold** (`isTaskHeldByBackgroundAgents` :603, `maybeReleaseHeldTask` :627, settle hold :2634–2650). It keys on `subagents.hasRunning(taskId)` for **every** kind. A subagent row left `running` at turn end would therefore park an OpenCode task in `running`.
- **Subagent SSE sink:** registered through `setSubagentEmitter(emit)` at :358. `emitRunEvent` (:350) and `appendRunStatusLine` (:4774) are the fan-out seams.

### 2c. Database and migrations

- `main` ends at **074**. `feature/add-gpt-6-1-terra` (`d98851e`) holds **075/076**. `feature/add-github-copilot-harness` has no commits; its investigation plans **075_copilot_harness.sql**, with kind id **`copilot`** and the CHECK union `('claude-code','codex','cursor','grok','gemini','kimi','fx','antigravity','opencode','copilot')` (that branch's `docs/plans/github-copilot-harness-investigation.md:331`). This plan therefore uses **077–079**, renumbered at merge with `aliases` (KB `7ff80535`).
- **Rebuild recipe:** `061_antigravity_harness.sql`. Migration 073 added `profile_mcp_servers`, which the 061 copy predates, so a new rebuild must copy it explicitly (KB `805945c6`).
- **Keep the harnesses rebuild order-independent:** no new columns on `harnesses` in this branch (see D-14). If this branch merged first, the Copilot branch's explicit-column rebuild would silently drop a new harnesses column.
- **Import precedent:** `tasks.imported_claude`/`imported_claude_session_id` (068–070) plus a partial unique index, and `claude_session_seen` (071). The import modules are `src/bun/claude-session-{scan,import,launch}.ts`, the routes `server.ts:5398–5436`, the dialog `ImportClaudeSessionsDialog.tsx` (imported by `App.tsx` and `ProjectPicker.tsx`), and the CLI `src/cli/commands/sessions.ts`.
- **`subagents` table** (022/027): `source_path TEXT NOT NULL`, `parent_kind` (the union lives in `types.ts:4837`: `subagent|bg_session|workflow|workflow_agent|monitor`). The Claude watcher seeds **every** row of a task (`claude-subagents.ts:1957`). The webview counts rows by `parentKind` (`RunPanel.tsx:2113`).

### 2d. Discovery, status and pickers

- **Per-harness probing** (account-scoped catalogs): `HarnessTarget{kind:"fx"|"codex"}` (`agent-discovery.ts:830`), `discoveryTargets`/`modelsForHarness`/`refreshHarnessModels` (`model-discovery.ts:59/92/168`). Codex's `app-server` JSON-RPC probe (`agent-discovery.ts:271`) is the precedent for a short-lived server probe. Cancel stdout readers in `finally` (KB `52d77b03`).
- **Model merging:** `mergeModelOptions` (`src/shared/model-options.ts`) rules 1–8. Rule 3 filters curated rows to discovered ids for `CATALOG_SCOPED_KINDS` (`types.ts:2583`). A sentinel row would be dropped without a new rule.
- **`supportedEfforts`** (`types.ts:3467`) keeps `auto` for fx only and filters discovered ids against `EFFORT_OPTIONS` (`:3154`). An OpenCode variant outside that list (e.g. `thinking`) would vanish.
- **Placeholder guard:** `src/bun/agents.test.ts:2580` forbids a model id `"default"` (the old placeholder). The sentinel id must be something else: **`opencode-default`**.
- **Status:** `checkHarness` (`agent-status.ts:475`) probes `--version` (2 s). fx's status probe is cached 60 s (`:381–410`). `GET /harnesses` (`server.ts:3902–3915`) runs `checkAllHarnesses()` over **all** rows, disabled included, then `noteHarnessStatuses`.
- **Usage chip:** `RunPanel.tsx:1807` only scans fx and cursor runs. The payload is `FxUsagePayload` (`types.ts:80–95`, `cost: {amount, currency}`).
- **TODO tracker:** `src/shared/todo-progress.ts:181` (legacy `TodoWrite`, `coerceTodoItem` :106). Shapes the tracker doesn't know map to a synthetic `TodoWrite` (fx's `plan` precedent).

### 2e. OpenCode facts (source-verified only, I§1–2 and the grill facts)

- Both lines take `run --format json`, `--auto`, `--agent`, `-s`, `--title`, `--thinking`.
- v2 adds `--standalone` and carries effort as `-m provider/model#variant`. v1 uses `--variant` and rejects unknown flags (`.strict()`).
- A positional prompt gets wrapped in literal quotes, so stdin is mandatory.
- NDJSON `{type, timestamp, sessionID, …}` with types `step_start|text|reasoning|tool_use|step_finish|error`. `tool_use` arrives once, at completion. There is no terminal event; the exit code (0/1/130) is the end signal. The session id is discovered (`ses…`).
- `run` emits only main-session events. The v2 `subagent` tool result names the child session id. `session list` is per project; `session export` prints JSON. Variants are only reachable through the server API.
- **Live spikes were blocked in step 1.** Wave 0 below captures real fixtures before code depends on any shape.

### 2f. Runnability

- **Setup:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install` (a fresh worktree has no `node_modules`).
- **Checks:** `bun run typecheck`, `bun test`.
- **E2E:** `bun node_modules/@playwright/test/cli.js test e2e/<spec>`, one run at a time.
- **Dogfooding:** only against `~/.agetor-dev` or a fresh `--data-dir`, never `~/.agetor` (memories "dogfood in dev dir" and "CLI smoke hits prod core").

## 3. Approach & key decisions

Each decision is tagged **[E]** (rests on evidence: source, grill or measurement) or **[R]** (rests on reasoning; it is checked in Wave 0 or listed in §8).

| # | Decision | Why / alternatives rejected |
| --- | --- | --- |
| D-1 | **Driver:** a new `src/bun/opencode-tmux.ts`, cloned from the antigravity driver. Shell wrapper: `"$@" < '<prompt>' > '<log>' 2>&1; echo $? > '<exit>'` inside `tmux new-session … -- sh -c <inner> sh <argv…>`. Logs live under `dataDir/opencode-logs/<runId>.{jsonl,prompt,exit}`. | [E] G2 and GD3. Stdin avoids the quote-wrapping and has no argv cap, so it needs no `prompt-limits` entry. ACP was rejected (G2). |
| D-2 | **Version seam:** a new `AgentRunOptions.cliVersion`. A pure `opencodeMajor(version)` in a new `src/shared/opencode.ts` returns `2` for a version ≥ 2 **or an unparseable one**, else `1`. `startTask` passes the version that `checkHarness` already probed. A follow-up turn uses `cachedCliVersion(harness)` (new in `agent-status.ts`, a 60 s memo keyed on `harness.id:path`, the same pattern as fx's status cache). | [E] G1. A per-turn `--version` probe without the cache would cost up to 2 s per message. |
| D-3 | **Argv** (built by `buildCommand`'s new opencode branch). Base: `opencode run --format json --thinking`. Then: model (none for the sentinel), effort (v2 `-m id#v`, v1 `-m id --variant v`; none for `auto` or the sentinel), mode (`auto` → `--auto`; `plan` → `--agent plan`), `-s <id>` when resuming, `--title <task title, ≤100 chars>` only when no session is being resumed, `--standalone` only on v2 when the effective server is standalone, then `AGETOR_OPENCODE_ARGS`. Env: `harnessEnv` plus `OPENCODE_DISABLE_AUTOUPDATE ??= "1"`. | [E] G3, G5, G6, G10, G13, GD2. |
| D-4 | **Per-task server option.** `type OpencodeServerMode = "shared" \| "standalone"`. It is stored in `tasks.opencode_server` and `agent_profiles.opencode_server` (TEXT, NOT NULL, default `'shared'`, with a CHECK). It is in `ALLOWED_PATCH_FIELDS`, the profile-bound field list, the freeze compare and copy (seven fields now), the snapshot, the pipeline step copy, bundles, and the CLI `--opencode-server`. The effective value comes from `effectiveOpencodeServer({mode, harnessHome, major})`: `null` on v1 (no flag), `"standalone"` when the harness has a home, else the task's value. An agent switch resets it to `"shared"`. A PATCH between turns applies on the next turn. | [E] G3–G3c and GD14. A non-OpenCode task stores it and ignores it, the way `maxMode` works. |
| D-5 | **Model sentinel.** `OPENCODE_DEFAULT_MODEL = "opencode-default"` is `DEFAULT_MODEL.opencode`. It is the only curated row and carries `pinned: true`. `mergeModelOptions` gains **rule 9**: a `pinned` curated row is always included, first, whatever discovery, scoping or `loggedIn` say. `opencode` joins `CATALOG_SCOPED_KINDS`. `buildCommand` omits `-m` for the sentinel. | [E] G4. [R] The id has no slash, so it can never equal a `provider/model` id (Zen's `opencode/…` included). The bare `"default"` was rejected by the guard at `agents.test.ts:2580`. |
| D-6 | **Effort.** `DEFAULT_EFFORT.opencode = "auto"` and `MODEL_EFFORT_SUPPORT.opencode = { "opencode-default": [] }`. `supportedEfforts("opencode", …)` returns: `[]` for the sentinel; `[]` for a model that was discovered with no variants; `[auto, …variants]` when variants were discovered (variant order kept; an id outside `EFFORT_OPTIONS` gets a synthesized `{id, label: id}` row); `[auto]` when the harness has no discovery entry for the model. `retainableEfforts` follows the same rule. | [E] G5. [R] Synthesized rows still come only from what the CLI reported, so the never-invent rule in `supportedEfforts`' doc holds. Every spawn passes the stored `task.effort` straight to `buildCommand` (KB `316509cf`), so `opencodeModelArgs` itself drops the effort for the sentinel and for `auto`; the picker hiding it is not enough. |
| D-7 | **Variant discovery.** `discoverOpencode(env, bin)` does three things. (1) It probes `--version`. (2) It runs `opencode models` (v2: `models --standalone`, GD9) and parses `provider/model` lines. (3) Best effort: it starts a short-lived `opencode serve` on an ephemeral port with `harnessEnv`, reads the model list with variants from the endpoint Wave 0 identifies, and kills the server in `finally`. The budget is ≤ 8 s total. Any failure means ids without efforts. Discovery is per harness: `HarnessTarget.kind` gains `"opencode"` and the `model-discovery.ts` gates widen. | [E] G5, GD9, KB `52d77b03`. The endpoint, port flag and auth are **unverified**, so Wave 0 measures them (S0-Q8). |
| D-8 | **Event mapping** (`mapOpencodeEvent`, pure, reads both lines). See the table in §4 (W1-C). Every part keeps a stable `line_uuid` (`opencode:<type>:<part.id>`), so a reattach replay from offset 0 dedups. Non-JSON lines are skipped (GD13). | [E] I§1b, GD13. |
| D-9 | **Resume and failed resume.** The id is discovered from the first non-empty `sessionID` and persisted on `runs.opencode_session_id`; resume uses `-s <id>` (GD4). When resuming, `spawnAgent` also builds a `freshArgv` (the same argv without `-s`, plus `--title`). If the turn fails before any line carries a `sessionID` and its error matches the resume-not-found pattern from Wave 0, the driver relaunches once with `freshArgv` and posts `couldn't resume OpenCode session <id8>… — starting a fresh session`. | [E] GD4. [R] v2 `-s` creates a missing session, so this mostly fires on v1 and after a v1→v2 upgrade (S0-Q4/Q13). |
| D-10 | **Stop and teardown.** Stop: `SpawnedAgent.kill()` sends `C-c` to the tmux session. The client's SIGINT interrupts the session, the client exits 130, and the run records `cancelled` (GD7). Delete, archive and agent-switch: `dropOpencodeSession` **always** sends `C-c`, polls `has-session` for up to 5 s, then kills the session. | [E] G3b. [R] Doing this in both modes means teardown never has to know which server mode an in-flight turn used: the mode can change between turns, and a reattached turn has no record of it. A Standalone client exits at once on SIGINT, so the wait there is ~0. |
| D-11 | **Subagent tabs** (G12). The mapper detects a `subagent` (v2) or `task` (v1) tool result that names a child `ses…` id. The driver calls `onSubagent`, and `opencode-subagents.ts` inserts a `subagents` row (`parentKind: "opencode_subagent"`, `sourcePath: "opencode-session:<child>"`, `status: running`, `toolUseId`). **Before the driver resolves `done`**, `refreshOpencodeSubagents` runs `opencode session export <child>` for every running or orphaned `opencode_subagent` row of the task. A complete child gets its events appended under `subagent_id` (line uuid `opencode:<partId>`) and is set `completed`. An unfinished child is set `orphaned`, with a status line `OpenCode subagent "<desc>" is still running — its tab fills when a later turn finishes`. Later turn ends re-check orphaned rows. Events reach the SSE stream through `setOpencodeSubagentEmitter(emit)`, registered by the orchestrator next to `setSubagentEmitter`. The Claude watcher's `seedRow` skips `opencode_subagent` rows. | [E] G12 and the grill facts. [R] No row is left `running` past settle, which keeps the background-agent hold (2b) from parking OpenCode tasks; this is the turn-end refresh the grill's open assumption asked for. |
| D-12 | **Shared export mapping.** A new `src/bun/opencode-export.ts` (`runOpencodeExport`, `exportToEvents`, `exportIsComplete`, `exportSummary`) is used by both subagent tabs and import, so the two can't drift. | [R] DRY. One shape, fixture-tested once. |
| D-13 | **Import** (G14/G14a). The design runs parallel to Claude's import rather than generalizing it. It adds `tasks.imported_opencode` (JSON) and `tasks.imported_opencode_session_id`, with a partial unique index (the claim), and a pure `importedSessionOf(task)` in a new `src/shared/imported-session.ts`. Every gate that reads `importedClaude` today switches to that helper: start 409, send refusal, RunPanel, TaskCard, context menu, CLI show/lifecycle. Pieces: new modules `opencode-session-scan.ts` (`session list --format json`, per enabled OpenCode harness × each registered project, `--standalone` on v2) and `opencode-session-import.ts` (one export → seed run `origin: "imported"` with `opencode_session_id` set → events written in cooperative 20 ms slices); routes `GET /opencode-sessions`, `POST /opencode-sessions/recheck`, `POST /opencode-sessions/import`; the Claude dialog generalized with a Harness column (renamed `ImportSessionsDialog.tsx`); `agetor sessions ls/import` covering both kinds; the launch scan extended inside `claude-session-launch.ts`. Seen ids share `claude_session_seen` (`ses…` ids can't collide with Claude uuids). | [E] G14a "same rules". [R] Renaming `imported_claude` would migrate a live column and touch the 17 call sites in `claude-session-import.ts` for no behavior gain. |
| D-14 | **Auto-enable when installed** (G8/G8a). A new `src/bun/harness-auto-enable.ts` keeps its bookkeeping in a new table `harness_auto_enabled(harness_id TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0)`, with **no FK and no harnesses column**. `applyHarnessAutoEnable(statuses)` acts on built-in rows of kind in `AUTO_ENABLE_KINDS = {codex, cursor, gemini, fx, opencode}` with `available === true` and no record yet. It sets `enabled=1` if the row is off, records the row (even when it was already on, so a later Off sticks), and fires `refreshHarnessModels`. It runs inside `GET /harnesses` before the response is built, and once at boot after the API binds (`index.ts`, `headless.ts`). The notice is an `AppEvent {type:"harnesses_auto_enabled", harnessIds, labels}`. Rows enabled but not yet notified are sent to the next `/app/events` client and marked notified (the `flushPendingClaudeSessionsNotice` pattern). Test seam: **off under `NODE_ENV=test`** unless `AGETOR_HARNESS_AUTO_ENABLE=1`; `e2e/fixtures.ts` sets `=0` by default. | [E] G8, G8a. [R] A FK to `harnesses` would cascade-delete on every future rebuild's `DROP TABLE harnesses`, and a harnesses column would break the Copilot rebuild's order independence (2c). The seam keeps existing tests that stub `AGETOR_CODEX_BIN=/bin/echo` from silently turning codex on. |
| D-15 | **`findLast*SessionId` harness fix** (G11). One helper, `findLastSessionIdForHarness(taskId, column, harnessId)`. It selects `(<col>, agent)` rows newest-first and returns the first whose `resolveHarness(agent)?.id === harnessId`; legacy rows that store a kind resolve to the built-in id (KB `e100e031`). `column` is a fixed whitelist union. It replaces codex, cursor, gemini, antigravity and fx (including `resumeFxRecovery` :5458 and the fx-paused gating) **and claude-code's `findLastClaudeSessionId`** (:6272; callers :5788, :6048, :6145, :7453). It is used for opencode from the start. Imported Claude seed runs carry the importing harness id, so they still resume. | [E] G11; claude-code added by the owner at plan approval. |
| D-16 | **Login hint** (G9). `HarnessStatus.notices?: string[]` holds neutral, non-blocking lines. OpenCode fills it from a cached (60 s) `opencode auth list` (`--format json` on v2) when no integration is listed: `No OpenCode credentials found — run \`opencode auth login\``. A v1 install also gets `OpenCode 2 is available: \`opencode upgrade --major\`` (GD12). `loggedIn` is always `null` for OpenCode, so it never blocks. The lines render in Settings → Harnesses (`harness-status-notice`), the Onboarding checklist and `agetor harness ls`. | [E] G9, GD12. One generic field instead of another kind-specific one like `fxProfilePermissionMode`. |
| D-17 | **Capability discovery** (G7). A new `opencode` branch in `listAvailableCommands` and `discoverMcpAndPluginExtensions`. Skills come from the user dirs `.config/opencode/skills` (under the harness HOME), `.claude/skills` and `.agents/skills`, and the project dirs `.opencode/skills`, `.claude/skills` and `.agents/skills`. Commands come from `.opencode/command/*.md` and `.opencode/commands/*.md` (user `.config/opencode/command(s)`). MCP comes from `opencode.json`/`opencode.jsonc` (user `~/.config/opencode/`, project root), reading v1 `mcp` and v2 `mcp.servers`, with JSONC comments stripped. `ref-tree.ts` `DEFAULT_PATHSPECS` gains `opencode.json` and `opencode.jsonc` (`.opencode` is already there). | [E] G7, GD11. |
| D-18 | **Fake driver** (`AGETOR_OPENCODE_DRIVER=fake`). `makeFakeOpencodeAgent` feeds **canned v2-shaped NDJSON through the real `mapOpencodeEvent`**, the cursor-stream precedent (`agents.ts:2959–3040`): text, reasoning, one `bash` tool, a `todowrite`, and `step_finish` with tokens and cost. It honors `resumeSessionId` (else `ses_fake<taskId8>`) and these markers: `__agetor_fake_opencode_subagent__` (emits a subagent tool result plus a canned child export via a `__forTest` seam), `__agetor_fake_opencode_error__` (an `error` event, exit 1), `__agetor_fake_opencode_resume_fail__` (the D-9 path). | [E] Same approach as every other kind's fake. |
| D-19 | **Opening breadcrumb.** Each OpenCode turn's first status line reads `opencode <major>.x · server=<shared\|standalone\|n/a> · model=<label> · effort=<id> · mode=<id>`. | [R] It gives e2e an assertable signal for the server option without exposing argv, and it helps users debug. |

## 4. Work breakdown — implementation tasks

### Wave 0 — fixtures before code

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| S0 | Install both OpenCode lines in isolation, capture real CLI output, and answer the open source-only questions | `src/bun/fixtures/opencode/**` (new), `docs/plans/add-opencode-harness-spikes.md` (new) | — | Every question below is answered with version + command, or marked `unverified (no keyless model)` with the source anchor used instead. Each fixture says in its header whether it is `captured` or `synthetic`. The Copilot kind id is re-read from `feature/add-github-copilot-harness` and recorded. |

**S0 recipe.**
- **Install v2:** `brew install opencode`.
- **Install v1:** `npm i --prefix <scratchpad>/oc1 opencode-ai@1` (owner-authorized, G16).
- **Isolation:** `HOME=<scratchpad>/oc-home` and `XDG_*` under it. Never touch `~/.local/share/opencode`. Bound every probe with `perl -e 'alarm N; exec @ARGV'` (macOS has no `timeout`). Look for a keyless free Zen id with `opencode models | grep '^opencode/'` and try one turn.

**Questions to answer.**

| # | Question |
| --- | --- |
| Q1 | `--version` output format on each line |
| Q2 | Stdin delivery inside `sh -c` with `< file` and no TTY |
| Q3 | NDJSON fixtures (text, reasoning, tool_use ok/error, `todowrite`, `step_finish` tokens and cost shape, pre-session and in-session `error`) for v1 and v2 |
| Q4 | `-s <unknown>`: the v1 error text, and whether v2 creates the session |
| Q5 | Does v1 reject `--standalone`? Does v2 reject `--variant`? |
| Q6 | What does an unknown variant do, on each line? |
| Q7 | `models` output; does v2 `models` accept `--standalone`? Does it list only credentialed providers? |
| Q8 | `serve`: port flag, ready line, auth requirement, and the endpoint plus JSON path for per-model variants, on both lines |
| Q9 | `auth list [--format json]` output when empty |
| Q10 | `session list --format json` shape on v2 and its v1 equivalent; is there any busy/status signal? |
| Q11 | `session export <id>` shape: messages and parts, completion marker, model/agent fields; does v2 export need `--standalone`? |
| Q12 | `subagent`/`task` tool result: the child id field and the background-mode text |
| Q13 | Does a session created Standalone resume when Shared, and vice versa? |
| Q14 | `tmux kill-session` mid-turn in Standalone leaves no `opencode serve` behind; does `C-c` in Shared stop the turn within 5 s? |
| Q15 | Is `--title` accepted? Is it ignored with `-s`? |
| Q16 | Exit codes |
| Q17 | The `OPENCODE_DISABLE_AUTOUPDATE` name and whether it is honored |

Wave 0 ends when the fixtures and spike doc are committed. Any verdict that contradicts §3 is written into the spike doc as an amendment with the decision row it changes. The executor applies amendments to the affected task briefs before Wave 1. A contradiction of a G# decision goes back to the owner.

### Wave 1 — the kind exists, compiles, migrates and runs through `spawnAgent`

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| W1-A | Shared types and pure helpers | `src/shared/types.ts`, `src/shared/model-options.ts`, `src/shared/opencode.ts` (new), `src/shared/imported-session.ts` (new), `src/shared/agent-profile.ts` | S0 | Union and every table carry `opencode`; the D-4, D-5, D-6, D-13, D-14 and D-16 types exist as pinned below; `mergeModelOptions` rule 9; `supportedEfforts` opencode branch |
| W1-B | Migrations and the db layer | `src/bun/migrations/077_opencode_harness.sql` (new), `src/bun/migrations/078_opencode_task_fields.sql` (new), `src/bun/migrations/079_harness_auto_enabled.sql` (new), `src/bun/migrations/index.ts`, `src/bun/db.ts` | W1-A types (same wave, pinned) | Migrations apply on a fresh DB and on an 074-era DB; every column round-trips through `toTask`, `toRun` and the profile mapper |
| W1-C | Driver, export mapping, subagent tabs, Claude watcher skip | `src/bun/opencode-tmux.ts` (new), `src/bun/opencode-export.ts` (new), `src/bun/opencode-subagents.ts` (new), `src/bun/claude-subagents.ts` | W1-A, S0 fixtures | Mapper passes the v1 and v2 fixtures; the driver launches, tails, settles on the exit file, reattaches and drops; subagent rows never stay `running` past settle |
| W1-D | `agents.ts` wiring | `src/bun/agents.ts` | W1-A, W1-C (pinned API) | `resolveBin`, `harnessEnv` (HOME + XDG), `buildCommand` (D-3), `spawnAgent` real and fake dispatch; no silent codex fall-through left for opencode |
| W1-E | Status, install and upgrade hints, notices, version cache | `src/bun/agent-status.ts` | W1-A | `INSTALL_HINTS.opencode = "brew install opencode"`; `BREW_PACKAGES.opencode`; `upgradeHintFor` → `brew upgrade opencode`, else `opencode upgrade`; `notices` (D-16); `cachedCliVersion` exported |
| W1-F | Model and variant discovery | `src/bun/agent-discovery.ts`, `src/bun/model-discovery.ts` | W1-A, W1-E (`cachedCliVersion` optional) | `discoverOpencode` (D-7) is in the index-aligned `allSettled` and `kinds` arrays; `runRefreshKind` case; per-harness gates include opencode |
| W1-G | Webview compile wiring (minimal, no new features) | `src/mainview/components/kanban/AgentIcon.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/api.ts`, `src/mainview/components/onboarding/OnboardingChecklist.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/settings/SettingsDialog.tsx` | W1-A | Icon `OpenCode` Mono; every `AgentModelMap` initializer and type; `HARNESS_HOME_COPY` and the home-capable list (:145); kind list (:1908); NewTaskForm `agentCache`/`seed`/hint chain; Onboarding `LOGIN_COMMAND = "opencode auth login"` and hint; RunPanel usage scan includes opencode (:1807); `bun run typecheck` green |

**W1-A pinned interfaces** (the other tasks code against these):

```ts
// src/shared/types.ts
export type AgentKind = … | "antigravity" | "opencode";
export type OpencodeServerMode = "shared" | "standalone";
export const OPENCODE_SERVER_MODES = ["shared", "standalone"] as const;
Task.opencodeServer: OpencodeServerMode;            // tasks.opencode_server
AgentProfile.opencodeServer: OpencodeServerMode;    // agent_profiles.opencode_server
AgentProfileSnapshot.opencodeServer?: OpencodeServerMode; // absent ⇒ "shared"
Run.opencodeSessionId?: string | null;
Subagent.parentKind: … | "opencode_subagent";
export interface ImportedOpencodeSession { sessionId: string; harnessId: string; directory: string;
  importedAt: number; status: "importing" | "ready" | "failed"; error: string | null; }
Task.importedOpencode?: ImportedOpencodeSession | null;
HarnessStatus.notices?: string[];
AgentOption.pinned?: boolean;
AppEvent |= { type: "harnesses_auto_enabled"; harnessIds: string[]; labels: string[] }
          |  { type: "opencode_sessions_found"; count: number; sessionIds: string[] }   // mirrors claude_sessions_found
export const AUTO_ENABLE_KINDS: ReadonlySet<AgentKind>;  // codex,cursor,gemini,fx,opencode
// src/shared/opencode.ts
export const OPENCODE_DEFAULT_MODEL = "opencode-default";
export function opencodeMajor(version: string | null | undefined): 1 | 2;
export function effectiveOpencodeServer(a: { mode: OpencodeServerMode; harnessHome: string | null; major: 1 | 2 }): OpencodeServerMode | null;
export function opencodeModelArgs(a: { model: string | null; effort: string | null; major: 1 | 2 }): string[];
export function parseOpencodeServerInput(v: unknown): OpencodeServerMode | { error: string } | undefined;
// src/shared/imported-session.ts
export function importedSessionOf(t: Pick<Task, "importedClaude" | "importedOpencode">):
  { kind: "claude-code" | "opencode"; sessionId: string; status: "importing" | "ready" | "failed"; error: string | null } | null;
```

**W1-A, also.**
- `AGENT_OPTIONS.opencode`:
  - models: `[{ id: "opencode-default", label: "OpenCode default", hint: "Use the model configured in OpenCode (no -m)", pinned: true }]`
  - modes: `[{id:"auto", label:"Auto", hint:"Build agent; approves every tool call (--auto)"}, {id:"plan", label:"Plan", hint:"OpenCode's Plan agent: no file edits, but shell commands still run; permission asks are rejected"}]`
  - efforts: `[auto row]`
- `CODE_PLAN_MODE.opencode = {code:"auto", plan:"plan"}`, `MODEL_MODE_DENY.opencode = {}`, `CATALOG_SCOPED_KINDS` gains `opencode`.
- An `EFFORT_OPTIONS.auto` doc update (fx and OpenCode).
- A `HARNESS_TEMPLATES` entry `opencode-additional`, suggested id `opencode-2`, home `{dataDir}/harnesses/opencode-2`.
- The `DEFAULT_MODEL` doc gains the one-exception note (G4).
- `agent-profile.ts`: the snapshot builder carries `opencodeServer`.
- The `DEFAULT_MODEL` docblock stays accurate for every other kind.

**W1-B detail.**
- **077:** a harnesses rebuild with the CHECK union `('claude-code','codex','cursor','grok','gemini','kimi','fx','antigravity','opencode','copilot')`. An explicit copy of **every** column, `profile_mcp_servers` included. Seed `('opencode','opencode','OpenCode',1,…, enabled 0)`. A self-heal re-seed of every built-in (claude-code 1, antigravity 1, codex/cursor/gemini/fx/opencode 0). `ALTER TABLE runs ADD COLUMN opencode_session_id TEXT`.
- **078:**
  - `tasks.opencode_server TEXT NOT NULL DEFAULT 'shared' CHECK (opencode_server IN ('shared','standalone'))` and the same on `agent_profiles`.
  - `tasks.imported_opencode TEXT`, `tasks.imported_opencode_session_id TEXT`, plus `CREATE UNIQUE INDEX tasks_imported_opencode_session_uidx … WHERE imported_opencode_session_id IS NOT NULL`.
  - An index on `runs(opencode_session_id) WHERE … IS NOT NULL` (the 069 precedent).
- **079:** `harness_auto_enabled`.
- **index.ts:** append the three, ids `077_…`/`078_…`/`079_…`.
- **db.ts:**
  - `getByIdOrKind` and the insert validator gain `opencode` (label "OpenCode").
  - The runs row type, mapper, INSERT and UPDATE gain `opencode_session_id`.
  - `tasks` insert/update/`toTask` gain `opencode_server`. It is patchable, so it **is** in the generic SET clause.
  - `imported_opencode*` is skipped by the generic SET. It is written only by a new `tasks.setImportedOpencode(id, value, {claim})`, which mirrors `setImportedClaude` (:1264–1290), alongside `findTaskByImportedOpencodeSession`, `importedOpencodeSessionIds()` and `importedOpencodeSessionHeldElsewhere()`.
  - `agentProfiles` insert/update/mapper gain `opencode_server`.
  - `parseAgentProfileSnapshot` reads a missing `opencodeServer` as `"shared"`.
  - A new `harnessAutoEnabled` module: `{ has(id), record(id, now), pending(): string[], markNotified(ids) }`.
  - Every `Task` literal in `db.ts` (e.g. `:1045`) gains the new fields.

**W1-C mapper contract** (`mapOpencodeEvent(line, ctx) → { chunks, sessionId?, subagent?, failed?, resumeNotFound? }`):

| NDJSON | Emits | `line_uuid` |
| --- | --- | --- |
| any line whose `sessionID` is non-empty, first one | `sessionId` (→ `onSessionId`) | — |
| `step_start` | nothing | — |
| `text` | `assistant` = `part.text` | `opencode:text:<part.id>` |
| `reasoning` | `thinking` = `part.text` | `opencode:reasoning:<part.id>` |
| `tool_use`, `state.status` `completed`/`error` | `tool_use {id: part.callID ?? part.id, name: part.tool, input: state.input, title: state.title}`, then `tool_result {toolUseId, content: state.output ?? state.error, isError: status==="error"}` | `opencode:tool:<part.id>:use` / `:result` |
| `tool_use`, tool `todowrite` | a `TodoWrite`-named tool_use with `input.todos` mapped to `{content, status}` (`cancelled` → `completed`), plus its result | same |
| `tool_use`, tool `subagent` (v2) or `task` (v1), result naming `ses…` | the normal pair plus `subagent: {childSessionId, description: input.description, agentType: input.subagent_type ?? input.agent ?? null, toolUseId}` | same |
| `step_finish` | `status` `FX_USAGE_STATUS_PREFIX + JSON` of the run's **cumulative** `{turn:{inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens}, cost:{amount, currency:"USD"}}` (ctx accumulates) | `opencode:usage:<part.id>` |
| `error` (v1 `{name,data.message}` / v2 `{type,message}`) | `status` `opencode: <message>`; `failed = true`; `resumeNotFound` when the S0-Q4 pattern matches and no `sessionID` has been seen | `opencode:error:<lineIndex>` |
| non-JSON line, unknown `type` | skipped | — |

**W1-C driver behavior.**
- **Settle:** the exit file drives settle. `0` means succeeded unless an `error` was seen; `130` means cancelled when the active handle's `cancelled` flag is set; anything else fails, with the last error message.
- **Death watch:** a `SESSION_DIED_STATUS_PREFIX` death watch, the antigravity pattern.
- **Launch failures:** tmux launch failures are surfaced (`80c015f`).
- **Fresh retry:** the D-9 retry with `freshArgv`.
- **Before resolving:** `beforeSettle` is awaited before `done` resolves (D-11).
- **Exports:** `spawnOpencodeViaTmux`, `reattachOpencodeSession`, `opencodeSessionActive`, `dropOpencodeSession(taskId, {graceMs = 5000})`, `interruptOpencodeTurn`.
- **Export mapping:** `opencode-export.ts` maps an export's message parts with the same part rules as the table above (one shared part→chunk function, exported from `opencode-tmux.ts`).
- **Claude watcher:** in `claude-subagents.ts` `seedRow`, an early `return` for `row.parentKind === "opencode_subagent"`, plus a one-line note at the parent-kind doc (`:96–136`).

**W1-D detail.**
- `resolveBin`: case `opencode` → `opencode` / `AGETOR_OPENCODE_BIN`.
- `harnessEnv`: an opencode branch → `HOME`, `XDG_CONFIG_HOME=<home>/.config`, `XDG_DATA_HOME=<home>/.local/share`, `XDG_STATE_HOME=<home>/.local/state`, `XDG_CACHE_HOME=<home>/.cache` (GD10).
- `AgentRunOptions` gains `cliVersion`, `opencodeServer`, `title`.
- The `buildCommand` opencode branch placed **before** the codex trailing code. `-m`/`--variant` come from `opencodeModelArgs`.
- `spawnAgent`:
  - **Real:** builds `built` and, when resuming, `freshArgv`, then calls `spawnOpencodeViaTmux` with `onSubagent → registerOpencodeSubagent` and `beforeSettle → refreshOpencodeSubagents({final:true})`, using `resolveBin(harness)`, `built.env`, `cwd` and the major.
  - **Fake:** D-18.
- Also convert the trailing codex code into an explicit `if (harness.kind === "codex")`, and end both `buildCommand` and `spawnAgent` with an exhaustive `const _never: never = harness.kind; throw …`. KB `785913e5` asks for this so the next kind can't fall through silently.

### Wave 2 — orchestration, routes, and the cross-kind backends

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| W2-A | Orchestrator plumbing for opencode; harness-scoped resume for all one-shot kinds; server-option flow; imported-session gates | `src/bun/orchestrator.ts`, `src/bun/pipeline-runner.ts` | Wave 1 | See detail. Turns queue, resume by discovered id, survive restart, and tear down per D-10. A same-kind harness switch never resumes the other harness's session (all six one-shot kinds). |
| W2-B | HTTP routes and both API clients | `src/bun/server.ts`, `src/mainview/lib/api.ts`, `src/cli/api-client.ts` | Wave 1; W2-A/C/D exports (pinned) | Kind validator and agent-models maps; `opencodeServer` validated (400 `opencodeServer must be one of shared, standalone`) on `POST /tasks`, `PATCH /tasks/:id`, profiles, duplicate and clone launch fields; bound-profile 409 list includes it; auto-enable hook in `GET /harnesses`; `/app/events` flushes the pending auto-enable and opencode-sessions notices; `/opencode-sessions*` routes; client functions for every route |
| W2-C | Auto-enable module and boot hooks | `src/bun/harness-auto-enable.ts` (new), `src/bun/index.ts`, `src/bun/headless.ts` | W1-B, W1-E | D-14 holds. Boot runs `checkAllHarnesses()` then `applyHarnessAutoEnable` once after the API binds (both entry points); `headless.ts` also calls `resumeIncompleteOpencodeImports()` (from W2-D) next to Claude's |
| W2-D | OpenCode import backend and launch scan | `src/bun/opencode-session-scan.ts` (new), `src/bun/opencode-session-import.ts` (new), `src/bun/claude-session-launch.ts` | W1-B, W1-C (`opencode-export.ts`) | List, import, refusals and resume-incomplete per D-13; the launch scan toasts unseen OpenCode ids (desktop only, like Claude's) |
| W2-E | Capability discovery | `src/bun/commands.ts`, `src/bun/ref-tree.ts` | W1-A | D-17 on disk and on a ref tree; v1 `mcp` and v2 `mcp.servers`; JSONC tolerated; exports `OPENCODE_USER_SKILL_DIRS` (pinned, consumed by W2-F) |
| W2-F | Bundle field and user-skill gate | `src/shared/bundle.ts`, `src/shared/bundle-import.ts`, `src/bun/bundle.ts` | W1-A, W1-B | `opencodeServer` is exported only when it isn't `"shared"`; the parser accepts it as an optional strict enum; it is in the planner fingerprint; a `rebound` reset sets `"shared"`; `userLevelSkills` covers opencode (via W2-E's `OPENCODE_USER_SKILL_DIRS` export from `commands.ts`); format stays version 1 (GD14) |

**W2-A detail.**
1. Imports from `opencode-tmux.ts` and `opencode-subagents.ts`, plus `setOpencodeSubagentEmitter(emit)` next to `setSubagentEmitter` (:358).
2. **Reconcile:** the `SELECT` adds `opencode_session_id`; the kind gate and key ternary add opencode; `reattachOpencodeSession` is in the dispatch (:797–898), wiring the same `onSubagent`/`beforeSettle`.
3. **Session id:** `onSessionId` maps opencode → `{ opencodeSessionId }` (:1799), and the trailing fx default becomes an explicit `fx` arm with an exhaustive `never` (KB `785913e5`).
4. **`startTask` spawn opts** gain `cliVersion: status.version`, `opencodeServer: task.opencodeServer` and `title: task.title`. It posts the D-19 breadcrumb for opencode.
5. **Turn queue:** `opencodeTurnQueue`, `sendOpencodeTurn`, `spawnOpencodeTurnNow` (uses `cachedCliVersion`) and `drainOpencodeQueue`, added to the drain sites (:2682/:2725). Agent-switch teardown and queue clear (:2769–2776), archive (:6826) and delete (:7173/:7198) use `dropOpencodeSession` (graceful, D-10). `sendInput` dispatch (:3747). `cancelRun` uses `interruptOpencodeTurn`.
6. **Harness-scoped resume:** `findLastSessionIdForHarness` (D-15) replaces the five one-shot `findLast*` bodies and `findLastClaudeSessionId`. Callers pass `resolveHarness(task.agent)?.id ?? task.agent`. fx recovery gating (:5458) and the claude callers (:5788, :6048, :6145, :7453) use it too.
7. **Agent switch** (:2790) also resets `opencodeServer: "shared"`.
8. **Agent profiles:** `effectiveAgentProfile` and `driftedFromRow` compare and copy `opencodeServer` (:1533–1542). `createTask` copies it from the profile, else from a valid `input.opencodeServer`, else `"shared"` (:6678). The cosmetic pipeline-parent copy (:6455–6497) follows the same rule.
9. **Imported sessions:** the start refusal (:1477) and send refusals (:3569–3581) use `importedSessionOf`. Messages: `imported OpenCode session — send a message to continue`, and while importing `OpenCode history is still importing`.
10. **`pipeline-runner.ts`:** step tasks copy `opencodeServer` from the frozen snapshot (default `"shared"`).

**W2-D detail.**
- **Scan:** `scanOpencodeSessions()` runs, for each enabled `opencode` harness and each `projects.list()` directory that exists, `opencode session list --format json` (cwd = the project, env = `harnessEnv`, bin = `resolveBin`, `--standalone` on v2, 5 s each, at most 4 concurrent, results cached by `(harnessId, dir)` for 10 s). It drops ids agetor owns (any `runs.opencode_session_id` match, or a claim). Each row carries `blockedReason: "missing-folder" | "busy" | null` (busy only when S0-Q10 finds a signal, else `null` plus `busyUnknown: true`, which the dialog shows as a warning, per the grill's fallback).
- **Import:** `importOpencodeSessions({harnessId, sessionIds})` runs per id:
  - Re-check the folder.
  - Claim through the unique index.
  - Create the task: `isolation: "none"`, `workdir` = the session directory, `agent` = harnessId, column `review`, title = session title, prompt = the first user text (else the title), mode `plan` when the last agent is `plan` (else `auto`), model = last `providerID/modelID` (else the sentinel), effort `auto`, `opencodeServer: "shared"`.
  - Seed run: `succeeded`, `origin: "imported"`, `opencode_session_id` = id.
  - Run one export and write its events in 20 ms cooperative slices via `runs.appendEvent` plus `emitRunEvent`.
  - Status goes `importing` → `ready`/`failed`.
- **Resume:** `resumeIncompleteOpencodeImports()` re-runs the export for rows left `importing`.
- **Launch scan:** `claude-session-launch.ts` runs the OpenCode scan after Claude's, under the same preference (§8 Q5) and the same pending-until-sent rule, emitting `opencode_sessions_found`.
- **No branch banner:** OpenCode sessions carry no git branch, so there is no "Switch to branch" banner.

### Wave 3 — clients (webview and CLI)

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| W3-A | Server option on every launch surface | `src/mainview/components/kanban/OpencodeServerPicker.tsx` (new), `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/AgentProfileFormDialog.tsx`, `src/mainview/components/kanban/AgentProfileDetailsDialog.tsx`, `src/mainview/lib/agent-profile-form.ts`, `src/mainview/components/kanban/CloneProjectDialog.tsx`, `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`, `src/mainview/components/kanban/ResolveConflictsDialog.tsx` | Wave 2 | A segmented Shared/Standalone picker (`launch-opencode-server`, `new-task-opencode-server`) shows only for an opencode harness on v2 (or an unknown version); it is locked to Standalone with a note (`opencode-server-locked-note`) for a harness with a home; it is sent on create/profile payloads; the profile form's dirtiness counts it as a launch interaction; the details dialog shows it; the effort picker follows D-6 |
| W3-B | Task details, subagent tabs, imported-session UI | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/lib/task-context-menu.ts` | Wave 2; W3-A picker (pinned props `{value, onChange, locked?: {reason: string}, disabled?, testId}`) | Task details shows `task-opencode-server` (locked by a bound profile like the effort select); `opencode_subagent` tabs label from `agentType ?? "agent"` and count as agents; every `importedClaude` read goes through `importedSessionOf` (send refusal copy, Commit & push hidden, Run hidden; the "Switch to branch" banner stays Claude-only) |
| W3-C | Import dialog, toasts, Settings, Onboarding | `src/mainview/components/kanban/ImportSessionsDialog.tsx` (renamed from `ImportClaudeSessionsDialog.tsx`), `src/mainview/components/kanban/ProjectPicker.tsx`, `src/mainview/App.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/components/onboarding/OnboardingChecklist.tsx` | Wave 2 | The dialog lists Claude and OpenCode rows with a Harness column, the busy-unknown warning and per-kind recheck; existing test ids kept (`e2e/import-claude-sessions.spec.ts` stays green); App toasts `harnesses_auto_enabled` ("Turned on Codex, Cursor… because they're installed — turn them off in Settings") and `opencode_sessions_found`, then reloads harnesses; Settings renders `notices`, offers the OpenCode template, and its launch-scan toggle copy mentions OpenCode; Onboarding renders `notices` |
| W3-D | CLI parity | `src/cli/commands/add.ts`, `src/cli/commands/agent-profile.ts`, `src/cli/commands/manage.ts`, `src/cli/commands/show.ts`, `src/cli/commands/lifecycle.ts`, `src/cli/commands/sessions.ts`, `src/cli/commands/harness.ts`, `src/cli/commands/attach.ts`, `src/cli/usage.ts`, `src/cli/test-fixtures.ts` | Wave 2 | `--opencode-server <shared\|standalone>` on `add`, `edit`, `profile add` and `profile edit`; a usage error with `--profile`/`--pipeline`; `show` and `profile show` print `opencode server:` for opencode; `sessions ls [--kind claude\|opencode]` and `sessions import <id>… [--harness <id>]`; `harness ls` prints notices; `harness shell` login hint `opencode auth login`; attach/usage copy lists opencode among the turn-only tmux kinds; `makeTask()` defaults `opencodeServer: "shared"` |

### Wave 4 — documentation and live verification

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| W4-A | Docs | `README.md`, `CLAUDE.md` | Wave 3 | README: harness table row, env-override table (`AGETOR_OPENCODE_BIN`/`_ARGS`/`_DRIVER`, `AGETOR_HARNESS_AUTO_ENABLE`), the enable-when-installed rule, the import of OpenCode sessions. CLAUDE.md: an `opencode` bullet under "Agent command shape" (argv per major, stdin, server option, sentinel, variants, subagent tabs, import); the env and fake-driver lists; Persistence notes for 077–079; the auto-enable and harness-scoped-resume rules; **`CLAUDE.md:102` corrected** to list the hand-edited sites |
| W4-B | Live smoke on real binaries | none (fixes found here are routed to a new task owning the affected file) | Wave 3, W4-A in parallel | On v2 (brew) and v1 (npm, via `AGETOR_OPENCODE_BIN`) against a fresh `--data-dir` headless core (recipe: KB `1ffb2336`): create → run → follow-up resumes → Stop → Standalone turn → subagent tab (if the model delegates) → import. If no keyless Zen model runs a turn, record "live verification open" in the PR body (G16) |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| W1-T1 | unit | W1-A | `src/shared/opencode.test.ts` (new), `src/shared/model-options.test.ts`, `src/shared/types.test.ts`, `src/bun/effort-support.test.ts` | `opencodeMajor` (≥2, <2, garbage → 2); `effectiveOpencodeServer` across all 3 inputs; `opencodeModelArgs` per major × sentinel × auto; rule 9 (pinned survives scoped, empty-discovery and logged-out); `supportedEfforts` for every branch in D-6, including a synthesized `thinking` row; existing `KINDS` invariants pass for opencode |
| W1-T2 | unit and integration | W1-B | `src/bun/migrate.test.ts`, `src/bun/harnesses.test.ts`, `src/bun/db-opencode.test.ts` (new) | Last-migration assertion; migrate to 076 → seed harness rows including an alias with `profile_mcp_servers=0` and a `copilot`-kind row → apply 077–079 → rows and columns preserved (the N-1 recipe, KB `0c9843b9`); built-in opencode row `enabled=0`; `getByIdOrKind("opencode")`; insert validator; `opencode_server` CHECK rejects junk; the imported-opencode unique claim; `harnessAutoEnabled` CRUD |
| W1-T3 | unit | W1-C | `src/bun/opencode-tmux.test.ts` (new), `src/bun/opencode-export.test.ts` (new), `src/bun/opencode-subagents.test.ts` (new) | Every mapper row in §4 against the v1 and v2 fixtures; non-JSON skipped; `line_uuid` stable on replay; cumulative usage; `todowrite` → `TodoWrite` feeds `deriveTodoProgress`; the wrapper argv (`< prompt`, prompt **not** in argv) through the `AGETOR_TMUX_BIN` stub (as in `antigravity-tmux.test.ts`); settle on exit 0/1/130; fresh retry; drop sends `C-c` then kill after the grace; a subagent row is created, then completed or orphaned at settle, never left running; the Claude watcher seed skips `opencode_subagent` |
| W1-T4 | unit | W1-D/E/F | `src/bun/agents.test.ts`, `src/bun/agent-status.test.ts`, `src/bun/agent-discovery.test.ts`, `src/bun/model-discovery.test.ts` | Argv matrix: major × mode × server × sentinel/model × effort × resume/title; env XDG under home; `OPENCODE_DISABLE_AUTOUPDATE` `??=`; exhaustive `never` arms; install/upgrade hints; notices (empty `auth list` → hint; v1 → upgrade note; probe failure → no notice, `loggedIn null`); `cachedCliVersion` TTL; `discoverOpencode` parse, the variants probe with a stub server, kill on timeout, readers cancelled; per-harness gates include opencode |
| W2-T1 | integration | W2-A | `src/bun/orchestrator-opencode.test.ts` (new), `src/bun/orchestrator-session-harness.test.ts` (new) | With the fake driver: start → session id persisted → follow-up resumes the same id → a second follow-up queued while busy drains in order; delete/archive/agent-switch clear the queue and call graceful drop; reconcile reattaches a running opencode run; an agent switch resets `opencodeServer`; the profile freeze copies it; for **each** of codex, cursor, gemini, antigravity, fx, opencode and claude-code, a same-kind harness switch starts fresh and switching back resumes the original; an imported Claude task still resumes its imported session; fx recovery gating respects the harness; imported-session refusals for both kinds |
| W2-T2 | integration | W2-B | `src/bun/server-opencode.test.ts` (new), `src/bun/model-discovery-endpoint.test.ts` | `POST /harnesses kind:"opencode"`; `opencodeServer` validation on every route; the bound-profile 409; `GET /harnesses` applies auto-enable (seam on) and returns the flipped row; `/opencode-sessions*` happy and refusal paths with a stubbed CLI; agent-models maps |
| W2-T3 | unit | W2-C | `src/bun/harness-auto-enable.test.ts` (new) | Each auto-enable kind turns on once when available; already-on rows are recorded; Off after the record sticks; not-available rows aren't recorded, then turn on later; a non-built-in row is never touched; the pending notice goes to the next client exactly once; the `NODE_ENV=test` default is off |
| W2-T4 | integration | W2-D | `src/bun/opencode-session-scan.test.ts` (new), `src/bun/opencode-session-import.test.ts` (new) | List across 2 projects × 2 harnesses with a stub `opencode`; owned ids hidden; missing folder blocked; busy or busy-unknown; import creates a Review task with seed run and events, and a duplicate import loses the claim; resume-incomplete; the launch-scan pending notice |
| W2-T5 | unit | W2-E | `src/bun/commands.test.ts` | OpenCode skills, commands and MCP from disk and from a ref tree; v1 vs v2 MCP shape; JSONC comments |
| W2-T6 | unit | W2-F | `src/shared/bundle.test.ts`, `src/shared/bundle-import.test.ts` | `opencodeServer` round-trips; omitted when `"shared"`; a junk value is refused; the fingerprint changes with it; an older file (no field) reads `"shared"` |
| W3-T1 | unit | W3-D | `src/cli/commands/add.test.ts`, `src/cli/commands/agent-profile.test.ts`, `src/cli/commands/sessions.test.ts`, `src/cli/commands/show.test.ts` | Flag parsing and mutual exclusion; the show lines; the sessions kind filter and import body |
| W3-T2 | e2e | W1–W3 user flows | `e2e/fixtures.ts`, `e2e/opencode-harness.spec.ts` (new), `e2e/opencode-import.spec.ts` (new), `e2e/harness-auto-enable.spec.ts` (new), `e2e/import-claude-sessions.spec.ts` | See below |

**E2e applies** to these flows. The change is user-visible end to end (webview → HTTP → orchestrator → tmux/fake driver → SSE).

1. **`opencode-harness.spec.ts`:**
   - (a) New Task → OpenCode → the model shows "OpenCode default", Server defaults to Shared → run → the transcript has assistant text, a thinking block, a tool card, the TODO card with board badge, and the usage chip → a follow-up shows `resuming OpenCode session ses_fake…` in the same session.
   - (b) Task details → Standalone → the next turn's D-19 breadcrumb reads `server=standalone`.
   - (c) Settings → Add harness → template "Additional OpenCode" → home copy shown → a task on it shows the locked Standalone note.
   - (d) The `__agetor_fake_opencode_subagent__` marker → a subagent tab appears and holds the child transcript after the turn.
   - (e) Settings shows the "No OpenCode credentials found" notice (the stub's `auth list` returns `[]`).
2. **`opencode-import.spec.ts`:** the stub answers `session list`/`export` → Import dialog row with harness "OpenCode" → import → the task in Review with history → Run refused with the 409 copy → a follow-up resumes with `-s` (breadcrumb).
3. **`harness-auto-enable.spec.ts`:** the backend with `AGETOR_HARNESS_AUTO_ENABLE=1` and the codex stub → toast "Turned on Codex…" → Settings shows Codex on → turn it off → the next poll leaves it off.
4. **`fixtures.ts`:** `AGETOR_OPENCODE_DRIVER: "fake"`; `AGETOR_OPENCODE_BIN` = a written stub script (answers `--version` → `2.1.4`, `models`, `auth list`, `session list --format json`, `session export <id>`, and exits for `serve`); `AGETOR_HARNESS_AUTO_ENABLE: "0"` by default.
5. **`import-claude-sessions.spec.ts`:** adjusted only if the renamed dialog moves a selector (test ids are kept on purpose).

**Run recipe.**
1. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install`.
2. `bun run typecheck`, then `bun test`.
3. `bun node_modules/@playwright/test/cli.js test e2e/opencode-harness.spec.ts e2e/opencode-import.spec.ts e2e/harness-auto-enable.spec.ts e2e/import-claude-sessions.spec.ts`.
4. Once green, the full suite: `bun node_modules/@playwright/test/cli.js test`, one Playwright run at a time.

**Environment.** The fixtures start the headless backend themselves, each on its own data dir. No credentials are needed: the fake driver plus the stub binary cover everything except W4-B. Serialize CLI suite runs across agents (memory "CLI tests hang under load").

## 6. Execution waves

| Wave | Tasks (parallel within a wave) | Barrier (checkpoint commit; tree must be green) |
| --- | --- | --- |
| 0 | S0 | Fixtures and spike doc committed; any amendments to §3 applied to the briefs (a G# contradiction goes back to the owner) |
| 1 | W1-A, W1-B, W1-C, W1-D, W1-E, W1-F, W1-G · W1-T1, W1-T2, W1-T3, W1-T4 | `bun run typecheck` green; `bun test` green apart from the 3 known `main` failures. The union change and all 21 `tsc` sites land together here, which is why W1-G exists |
| 2 | W2-A, W2-B, W2-C, W2-D, W2-E, W2-F · W2-T1 … W2-T6 | typecheck plus `bun test` green; the existing e2e suite **not** run yet (the client features land in W3) |
| 3 | W3-A, W3-B, W3-C, W3-D · W3-T1, W3-T2 | typecheck, `bun test`, the four e2e specs, then the full e2e suite once |
| 4 | W4-A, W4-B | Docs merged; live-smoke result recorded; any fix found re-runs the affected unit tests and specs |

**File-ownership check (done while writing this plan).** No path appears twice within a wave.
- **Hot files with a single owner per wave:** `types.ts` (W1-A), `db.ts` (W1-B), `agents.ts` (W1-D), `orchestrator.ts` (W2-A), `server.ts`/`api.ts`/`api-client.ts` (W2-B), `index.ts`/`headless.ts` (W2-C).
- **Webview files across waves:** `RunPanel.tsx`, `NewTaskForm.tsx`, `TaskLaunchPickers.tsx`, `SettingsDialog.tsx`, `App.tsx` and `OnboardingChecklist.tsx` are owned once in W1 (W1-G, compile wiring) and once in W3 (features); `api.ts` is W1-G, then W2-B. Each file has one owner per wave.
- **`claude-subagents.ts`:** owned only by W1-C.

**Sizing.** 4 waves after the spike; 32 tasks (19 implementation, W4-B among them although it owns no file; 1 spike; 12 test). The widest wave is W1, with 11 parallel tasks. Validated mechanically: a script parsed every task row's owned paths and found no duplicate within any wave (W0: 2 paths, W1: 40, W2: 26, W3: 36, W4: 2).

## 7. Blast radius & risks

- **Migration collision.** Terra holds 075/076 and Copilot plans 075. The 077 CHECK already lists `copilot`, and Copilot's lists `opencode`, so either merge order copies cleanly as long as **neither branch adds a `harnesses` column** (D-14 keeps this branch clean). Renumber with `aliases` at merge; `migrate.test.ts` pins the last id.
- **Silent fall-through** to codex, gemini or fx for a half-wired kind. Mitigated by the explicit opencode arms plus exhaustive `never` throws (W1-D, W2-A) and the W1-T4 argv matrix.
- **Prompt quoting.** Stdin only; W1-T3 asserts the prompt is never in argv.
- **Shared-mode turns outliving agetor control.** Graceful `C-c` + 5 s on teardown (D-10). Stop = `C-c`. Accepted: a crash of the tmux client in Shared mode can leave the turn running in OpenCode's service.
- **Auto-enable surprises.**
  - It reverses the shipped `enabled=0` posture for four kinds.
  - The first pass on existing DBs may re-enable a deliberately-off harness (accepted, G8a), and the toast explains it.
  - CLI-only users see no toast (`agetor harness ls` shows the state; §8).
  - Tests are protected by the `NODE_ENV=test` and e2e seam defaults.
- **Harness-scoped resume** changes behavior for every one-shot kind and for claude-code: after a same-kind switch, the next turn starts fresh instead of resuming another account's session. That is the intended fix, and W2-T1 covers all seven kinds.
- **Background-agent hold.** OpenCode subagent rows never stay `running` at settle (D-11); otherwise tasks would park in `running`.
- **Account-scoped catalogs.** The sentinel is always runnable; discovered rows are per harness; a logged-out distrust (rule 7) can't hide the pinned sentinel (rule 9).
- **Main-thread budget.** Import writes in 20 ms slices; scan probes are concurrency-capped; discovery's `serve` probe is time-boxed with readers cancelled.
- **OpenCode reads `.claude/` instructions** (GD11, accepted). An agetor worktree's `CLAUDE.md` becomes OpenCode context.
- **Rollback.** Code reverts cleanly. The migrations are additive (new columns, a new table, a rebuild that only widens the CHECK); a rollback is a new migration, never an edit. There is no feature flag: OpenCode stays invisible until its CLI is installed, because its built-in row seeds off.

## 8. Open questions / assumptions

| # | Open point | Proceeding on | Confirm with |
| --- | --- | --- | --- |
| Q1 | Should the harness-scoped resume fix also cover `findLastClaudeSessionId` (`orchestrator.ts:6272`)? | **Resolved — yes** (owner, plan approval 2026-10-27); now part of D-15 and W2-A | — |
| Q2 | Is the Copilot kind id `copilot`? | `copilot`, from the Copilot investigation §7 (`:331`); S0 re-checks the branch; the CHECK is edited if it changed before merge | S0 / merge time |
| Q3 | Final migration numbers | 077–079, renumbered with `aliases` at merge | Merge time |
| Q4 | Toast on fresh installs too? | **Resolved — yes**, one mechanism for new and existing DBs (owner, plan approval) | — |
| Q5 | Launch-scan preference | **Resolved — shared**: the existing `claudeSessions.launchScan` toggle governs both kinds, copy updated, no new setting (owner, plan approval) | — |
| Q6 | Teardown mode-awareness | Always `C-c` + ≤5 s (D-10 [R]) | — |
| Q7 | Unfinished subagent at turn end | `orphaned` + status line; re-checked at later turn ends (D-11 [R]) | — |
| Q8 | v1 parity for subagents, import and variants | Built for both lines. If S0 shows v1 lacks `session export`/`list` or a child id, that surface becomes v2-only with an explicit "not available on OpenCode 1" notice, recorded in the spike doc — never silently missing | S0 |
| Q9 | Standalone↔Shared resume | Works (same `opencode.db`); if S0-Q13 says no, D-9's fresh-session fallback plus breadcrumb covers it | S0 |
| Q10 | Variants endpoint and the busy signal | Per S0-Q8/Q10; fallbacks: "Model default" only, and a busy-unknown warning | S0 |
| Q11 | A keyless Zen model for the live smoke | If none exists, live verification stays open in the PR body (G16) | W4-B |
| Q12 | `cancelled` todos map to `completed` | Keeps the tracker's progress finishing (D-8 [R]) | — |

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| `AgentKind` union and all six type-checked tables | In this run | W1-A |
| `INSTALL_HINTS`/`BREW_PACKAGES`/`upgradeHintFor` | In this run | W1-E |
| `AgentIcon`, `HARNESS_HOME_COPY`, home-capable and kind lists, AgentModelMap initializers and type, NewTaskForm/Onboarding hint chains | In this run | W1-G |
| `db.ts` `getByIdOrKind`, insert validator, runs row columns | In this run | W1-B |
| `server.ts` harness kind validator and agent-models maps | In this run | W2-B |
| Discovery `allSettled` + index-aligned `kinds`, `runRefreshKind`, per-harness gates | In this run | W1-F |
| `agents.ts` `resolveBin`/`harnessEnv`/`buildCommand`/`spawnAgent` + fake driver | In this run | W1-D |
| Exhaustive `never` arms replacing silent codex/fx fall-throughs (KB `785913e5`) | In this run | W1-D, W2-A |
| New driver, mapper, tailer, death watch, launch-failure surfacing (`80c015f`) | In this run | W1-C |
| Orchestrator reconcile/reattach, `onSessionId`, queue/turn/drain, agent-switch, archive, delete, `sendInput`, `cancelRun` | In this run | W2-A |
| Turn queue cleared on delete (the `80c015f` lesson) | In this run | W2-A, W2-T1 |
| Harnesses rebuild migration (CHECK incl. `copilot`, copies `profile_mcp_servers`, seed, self-heal) + `runs.opencode_session_id` | In this run | W1-B (077) |
| Per-task server option: column, PATCH allow-list, validation, bound-profile list, freeze copy, snapshot, pipeline step copy, bundle, CLI, every launch surface, task details | In this run | W1-A, W1-B, W2-A, W2-B, W2-F, W3-A, W3-B, W3-D |
| Server option locked for home harnesses, hidden on v1 | In this run | W1-A (`effectiveOpencodeServer`), W3-A, W3-B |
| Shared-mode graceful teardown | In this run | W1-C, W2-A |
| "OpenCode default" sentinel + `mergeModelOptions` rule 9 | In this run | W1-A |
| Effort variants: discovery + picker | In this run | W1-F, W1-A, W3-A |
| Modes Auto/Plan, mode hints saying Plan still runs shell | In this run | W1-A |
| Skills/commands/MCP discovery, `ref-tree` pathspecs | In this run | W2-E |
| Bundle `userLevelSkills` gate for opencode | In this run | W2-F |
| Auto-enable-when-installed for codex/cursor/gemini/fx/opencode, existing DBs once, toast | In this run | W2-C, W2-B, W3-C |
| Harness-scoped resume for every one-shot kind (incl. fx recovery gating) | In this run | W2-A, W2-T1 |
| Harness-scoped resume for claude-code | In this run | W2-A, W2-T1 (owner, plan approval) |
| Login hint (fail-open notices) in Settings/Onboarding/CLI | In this run | W1-E, W3-C, W3-D |
| Usage chip, `todowrite` tracker + board badge, `--thinking`, auto-update off | In this run | W1-C, W1-D, W1-G (RunPanel usage scan) |
| Subagent tabs filled on completion + turn-end refresh + Claude watcher skip | In this run | W1-C, W2-A, W3-B |
| Session title on creation | In this run | W1-D, W2-A |
| Import of outside sessions (scan, import, refusals, dialog, CLI, launch scan, resume-incomplete) | In this run | W1-B, W2-D, W2-B, W2-C, W3-B, W3-C, W3-D |
| Imported-session gates generalized (`importedSessionOf`) | In this run | W1-A, W2-A, W3-B, W3-D |
| `HARNESS_TEMPLATES` OpenCode entry | In this run | W1-A |
| `HARNESS_TEMPLATES` Antigravity entry (pre-existing gap, KB `785913e5`) | Out of scope | A different ticket: an Antigravity UX gap unrelated to OpenCode |
| CLI attach/usage copy listing opencode | In this run | W3-D |
| README + CLAUDE.md docs, `CLAUDE.md:102` correction | In this run | W4-A |
| Fixtures from real v1/v2 binaries | In this run | S0 |
| Live smoke on both lines | In this run (stays open if no keyless model, G16) | W4-B |
| e2e coverage: harness flow, import, auto-enable; fixtures env | In this run | W3-T2 |
| Existing tests broken by the new built-in row / kind (`migrate`, `harnesses`, `types` invariants, `effort-support`, `agents` placeholder guard) | In this run | W1-T1, W1-T2, W1-T4 |
| ACP driver / interactive permission cards | Out of scope | Owner G2 — a different architecture and ticket |
| A third "no auto-approve" mode | Out of scope | Owner G6 |
| Plan-approval card for OpenCode Plan | Out of scope | Owner G6a |
| Live-updating subagent tabs (DB reads / export polling) | Out of scope | Owner G12 chose fill-on-completion |
| Renaming an OpenCode session on task rename | Out of scope | Owner G13 (no v2 CLI rename) |
| Importing sessions from folders agetor doesn't know | Out of scope | Owner G14 |
| Speed tiers / Max Mode for OpenCode | Out of scope | Evidence: no fast-lane flag; `supportedSpeeds` → `["off"]` already |
| Existing `harnesses` rows | In this run | W1-B explicit-column copy, tested by W1-T2 |
| Existing task/profile rows (no `opencode_server`) | In this run | 078 `DEFAULT 'shared'` backfills every row |
| Frozen snapshots / bundle files without the field | In this run | Lenient reads → `"shared"` (W1-B, W2-F) |
| Orphaned code | None | The change is additive; the reversed `enabled=0` posture is handled at runtime (D-14), with no seed edits to old migrations |

### 9a. Execution addendum (Implementing step, 2026-10-27)

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Spike amendments A1–A15 (wrapper `trap 'true' INT`, `api --standalone model.list` / `models --verbose` instead of `serve`, v1 `opencode export`, v1-only resume-not-found, field paths) | In this run | Applied in W1-C/W1-D/W1-E/W1-F/W2-D briefs |
| Owner: v2 `todowrite` needs `experimental.todo` (no config injection) | In this run | Documented (README, CLAUDE.md); G10 refined by owner |
| Owner: busy import refused only when unfinished AND updated < 10 min | In this run | W2-D (G14a refined by owner) |
| Live-smoke fixes: v1 error cause line, first-run `--standalone` probe race (retry once), auth cache keyed on probe env | In this run | W4-B |
| OpenCode 1 sharing a home with OpenCode 2 ("Database is not empty…") | In this run | Notice in `agent-status.ts` + docs (final sweep) |
| Tests ran the real `opencode` and wrote into the owner's `$HOME` | In this run | `src/test-preload.ts` + `agents.test.ts` env restore; polluted dirs removed |
| Harness rows leaking across test files (process-wide db) | In this run | `src/bun/test-harness-state.ts` |
| Reconcile drained a queued follow-up onto the new harness during the 5 s graceful drop; archive missed `antigravityTurnQueue` | In this run | W2-A |
| D-19 breadcrumb naming the real model behind "OpenCode default" (`GET /api/model/default`) | Out of scope | Spike A11 marks it optional; the label "OpenCode default" is accurate |
| v1 Stop leaves the bash tool's child process running | Out of scope | OpenCode 1 behavior (spike Q14/A1); v1 is the legacy line, documented |
| RunPanel idle-task placeholder "resumes the conversation in a fresh session" (`RunPanel.tsx`) | Out of scope | Pre-existing copy for every kind, unrelated to OpenCode (found by W3-T2) |
