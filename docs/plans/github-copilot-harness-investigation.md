# Investigation — GitHub Copilot CLI harness

| Field | Value |
| --- | --- |
| Date | 2026-10-26 |
| Change | Add GitHub Copilot CLI (`copilot`, npm `@github/copilot`) as a seventh agetor `AgentKind`. This brief informs two decisions: which driver architecture to use (tmux one-shot per turn vs ACP over stdio), and which product calls the owner has to make before planning. |
| Agents | None. The pipeline step forbade subagents, so the codebase, git-history, web and spike passes were all run inline. |
| Flags | none (spikes ran) |

**TL;DR.** Copilot CLI 1.0.104 has a clean headless contract that maps onto agetor's existing **tmux one-shot driver** pattern (codex/cursor/gemini/antigravity):

- `copilot -p …` (or the prompt on stdin) with `--output-format json` gives JSONL that is flushed per event.
- It accepts a **self-issued `--session-id <uuid>`** that creates *or* resumes a session (the gemini pattern).
- `--reasoning-effort` is a real per-run flag, and `--mode plan` gives a real plan mode.
- `COPILOT_HOME` is a dedicated config-dir override for multi-account harnesses.

It also has an **ACP server** (`copilot --acp`, fx-style), which is the only route to interactive permission cards. Everything below the driver choice (types, migration, status probe, discovery, UI, CLI, docs) follows the Antigravity PR (#256) almost line for line.

Two things matter most for the plan. First, an unknown kind falls through **silently** at several dispatch points (to the codex spawn, gemini's env var, fx's session-id column), and the typechecker catches only 21 of the sites. Second, a concurrent branch (`feature/add-opencode-harness`) is adding an `opencode` kind and needs the same harnesses-table rebuild migration.

---

## 1. What we know

### 1a. GitHub Copilot CLI (external facts)

Sources: `copilot --help` and `copilot help <topic>` on 1.0.104, the bundled `schemas/session-events.schema.json` and `changelog.json`, docs.github.com.

- **Distribution.**
  - npm `@github/copilot` (latest **1.0.104**, published 2026-10-27; a thin `npm-loader.js` execs the native per-platform binary from `@github/copilot-darwin-arm64`, and needs Node ≥ 22).
  - Homebrew **cask** `copilot-cli` (1.0.103 in the local index, `auto_updates`).
  - Install script `curl -fsSL https://gh.io/copilot-install | bash`.
  - First launch extracts a ~204 MB package to `~/Library/Caches/copilot/pkg/<platform>/<version>/`.
  - Self-update: `copilot update`. Standalone and cask builds auto-download updates unless `COPILOT_AUTO_UPDATE=false` or `--no-auto-update`.
  - Release cadence is very fast: the bundled changelog lists **174 stable versions**.
- **Name collision (real, on this machine).** `brew info copilot-cli` fails with "Refusing to load formula aws/tap/copilot-cli from untrusted tap": the owner has `aws/tap` tapped, whose **formula** `copilot-cli` is *AWS Copilot*, which also installs a binary named `copilot`. GitHub's CLI is the **cask** (`brew info --cask copilot-cli`). So hints must say `--cask`, and the binary needs identifying: `copilot --version` prints `GitHub Copilot CLI 1.0.104.`, a usable marker (same idea as fx's `FX_HELP_MARKER`, `src/bun/agent-status.ts:114-140`).
- **Not installed here.** `which copilot` finds nothing. `~/.copilot/` exists (config.json/ide/logs from an IDE integration), but there is no `gh auth` and no Copilot login. No live (billed) run was possible or attempted.
- **Prompt mode.**
  - `-p/--prompt <text>`, or the prompt **piped on stdin with no `-p`** (spike A_stdin). When both are given, `-p` wins.
  - Options that matter for agetor:
    - `--model <id|auto>` and `--reasoning-effort none|minimal|low|medium|high|xhigh|max`
    - `--mode interactive|plan|autopilot`, `--plan`, `--autopilot`, `--max-autopilot-continues`
    - `--allow-all`/`--yolo`, `--allow-all-tools`, `--allow-tool`/`--deny-tool`, `--assisted-approval`
    - `--no-ask-user`
    - `--session-id <uuid>`, `-r/--resume[=<id|prefix|name>]`, `--continue`, `-n/--name`
    - `--output-format text|json`, `-s/--silent`, `--usage-output-file <file>`
    - `--trust-folder`, `--add-dir`, `--additional-mcp-config`, `--disable-builtin-mcps`, `--no-custom-instructions`, `--max-ai-credits`
    - `--log-dir`, `--no-color`, `--no-auto-update`, `-C <dir>`, `--acp`
  - The full help is in the spike artifacts.
- **JSONL contract (`--output-format json`).**
  - One object per line: `{type, data, id(uuid), timestamp, parentId, ephemeral?}`. Every event has a stable uuid `id`, which is a natural `line_uuid`.
  - The bundled schema lists ~200 types. Ones seen live:

    | Event | Ephemeral | Notes |
    | --- | --- | --- |
    | `user.message` | no | |
    | `assistant.turn_start` / `assistant.turn_end` | no | per model sub-turn, *not* per user turn |
    | `assistant.message_start` / `assistant.message_delta` | yes | |
    | `assistant.message` | no | `{messageId, content, toolRequests[], model}` |
    | `assistant.tool_call_delta` | yes | |
    | `tool.execution_start` | no | `{toolCallId, toolName, arguments}` |
    | `tool.shell_output` / `tool.execution_partial_result` | yes | |
    | `tool.execution_complete` | no | `{toolCallId, success, result.content \| error.message}` |
    | `session.error` | no | `{errorType, message, statusCode}` |
    | `session.info` / `assistant.turn_retry` / `model.call_failure` | yes | |
    | `abort`, `assistant.idle {aborted?}` | | |
    | `instruction.update`, `session.mode_notice_delivered` | | |
    | `session.autopilot_stopped` | | |
    | `result` | | final: `{sessionId, exitCode, usage{premiumRequests, totalApiDurationMs, sessionDurationMs, codeChanges}}` |

  - `result` is the turn-terminal signal. `assistant.idle` precedes it.
  - Other schema-documented types matter to agetor but weren't exercised:
    - `assistant.reasoning {reasoningId, content}` (thinking)
    - `subagent.started/completed/failed`, and `parentToolCallId` on nested events
    - `exit_plan_mode.requested {summary, planContent, actions}`
    - `session.plan_changed`
    - `session.todos_changed` (signal only; the todos live in the session SQLite)
    - `session.compaction_start/complete`, `session.warning`, `session.quota_observation`, `user_input.requested`, `permission.requested`
- **Session state.**
  - `$COPILOT_HOME/session-state/<sessionId>/` holds `events.jsonl` (non-ephemeral events, appended across resumes, with `session.start`/`session.resume`/`session.shutdown` and `session.usage_record`), `workspace.yaml` (cwd, git_root, branch, name), `plan.md` (plan mode), `checkpoints/`, `files/`, `research/`.
  - `$COPILOT_HOME/config.json` is **JSONC** (comment header). Settings live in `settings.json`.
- **Auth.**
  - `copilot login` uses the browser flow locally and device code when headless. It stores the token in the macOS keychain, falling back to a plain-text file under `COPILOT_HOME`.
  - Env tokens **take precedence over the stored login**: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`. Fine-grained PATs with "Copilot Requests", Copilot-CLI OAuth and gh OAuth tokens are accepted. **Classic `ghp_` PATs are not.**
  - Unauthenticated `-p` exits **rc 1** with a plain-text stderr block ("Error: No authentication information found. …"), writes nothing to stdout, and still creates a session-state dir.
  - Neither `copilot version` nor `copilot config --list --json` reveals login state. ACP `session/new` returns `-32000 "Authentication required"`.
- **Entitlement / billing.**
  - Users need a Copilot seat, and Copilot CLI must be enabled by org/enterprise policy for Business/Enterprise.
  - Since 2026-06-01, Copilot bills **per token as AI Credits** (Pro $10 / Pro+ $39 monthly pools; annual plans stay on premium requests until renewal).
  - `--model auto` (Copilot's own router) is GA on all plans with a 10% multiplier discount.
  - Whether Copilot Free includes the CLI is unconfirmed.
- **Model ids.**
  - `copilot help config` prints the bundled model list **offline, without auth**. 1.0.104 lists 31: claude-sonnet-5.5, claude-sonnet-5, claude-fable-5.1, claude-fable-5, claude-opus-5.5, claude-opus-5, claude-opus-4.8, claude-opus-4.8-fast, claude-sonnet-4.6, claude-haiku-5.5, claude-haiku-4.5, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5-mini, mai-code-1.1-flash, gemini-4-argon, gemini-3.8-flash, gemini-3.7-flash, grok-4.7, grok-4.6, grok-4.5, kimi-k3. `auto` is also accepted.
  - The list lives in the native `runtime.node`, not the JS.
  - The CLI version that added each model is in the changelog: gpt-6.1-sol 1.0.90, claude-opus-5.5 1.0.89, gemini-4-argon 1.0.98, gpt-6-astra 1.0.85, claude-fable-5.1 1.0.83, kimi-k3 1.0.79, grok-4.5 1.0.76, claude-opus-5 1.0.75 … (sonnet-5.5/haiku-5.5/gpt-6-sol/luna/gemini-3.8/grok-4.7/mai-code not matched by the phrasing search).
  - The **default model is not documented**. The changelog shows it moving (Sonnet 4.5 → 4 → 4.6).
- **Effort.** The changelog (1.0.88) says that for an effort level the selected model doesn't offer, the CLI "is reported and left unapplied", so effort never fails a run.
- **Instructions, skills, MCP.**
  - Repository instructions include `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` (`copilot instruction list` in this worktree lists CLAUDE.md). Since 1.0.89, `.claude/rules` too.
  - Skills: project `.github/skills/`, `.agents/skills/`, `.claude/skills/`; personal `~/.copilot/skills/`, `~/.agents/skills/`.
  - MCP: user `~/.copilot/mcp-config.json`; workspace `.mcp.json` or `.github/mcp.json`. Built-ins `github-mcp-server` and `githubiq` can be disabled with `--disable-builtin-mcps`.
  - Custom agents: `~/.copilot/agents`, `.github/agents`.
  - Copilot adds a `Co-authored-by` trailer to agent commits by default (`includeCoAuthoredBy: true`, settings only, no flag).
- **Sandbox.** Command sandboxing is **off by default** (`help sandbox`). A user can enable it globally (`sandbox.enabled`), or org policy can force it. When on, shell commands run in Seatbelt with restricted paths and network.
- **ACP mode** (`copilot --acp --stdio`, public preview):
  - `initialize` advertises `loadSession`, `sessionCapabilities {close, list}` and `authMethods [copilot-login]`.
  - `session/new` returns `configOptions` `mode` (agent/plan/autopilot, as session-mode URLs) and `allow_all` (on/off).
  - Mutating tools trigger `session/request_permission` with `allow_once`/`allow_always`/`reject_once`.
  - Streams `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update {used, size}` and `session_info_update {title}`. The `session/prompt` result is `{stopReason, usage{inputTokens…}}`.
  - Effort and tool filters are **server-start flags** (`--effort`, `--available-tools`), so they're fixed per process. Agetor spawns a process per turn anyway.

### 1b. Agetor codebase (how a kind is wired today)

- **Template PR.** Antigravity (#256, `4901a10`) touched 19 files with +1,239 lines. A follow-up `80c015f` was needed ("surface tmux launch failures and clear queue on delete").
  - The larger Cursor PR (#98, `06fd021`) touched 45 files, mostly test fixtures adding `cursorSessionId: null`.
  - Antigravity dodged that churn by making `Run.antigravitySessionId` **optional** (`src/shared/types.ts:3951`).
  - Kimi and Grok kinds were built on side branches and **never merged** (`git merge-base --is-ancestor a5e4af6 HEAD` → not on HEAD). Their kinds survive only in the harnesses CHECK constraint.
- **Shared tables.** `src/shared/types.ts`:
  - `AgentKind` union `:296`
  - `DEFAULT_MODEL` `:2511`
  - `CATALOG_SCOPED_KINDS` `:2583`
  - `DEFAULT_EFFORT` `:2584`
  - `MODEL_MIN_CLI_VERSION` `:2638` (Partial)
  - `CODE_PLAN_MODE` `:3099`
  - `EFFORT_OPTIONS` `:3154` (already contains none/minimal/low/medium/high/xhigh/max)
  - `MODEL_EFFORT_SUPPORT` `:3186`
  - `MODEL_MODE_DENY` `:3537`
  - `AGENT_OPTIONS` `:3597` (antigravity `:3843`)
  - `Run` session-id fields `:3911-3951`
  - `HARNESS_TEMPLATES` `:985` (has no antigravity entry, a pre-existing gap)
  - `USAGE_SUPPORTED_KINDS` `:1829`
- **Driver template.** `src/bun/antigravity-tmux.ts` (548 lines).
  - Paths derive from runId (`:44-69`). `mapAntigravityEvent` maps events (`:144`).
  - The tailer (`fs.watch` + 150 ms poll + death probe, `:339-409`) is the core.
  - `spawn…ViaTmux` uses `sh -c '"$@" "$(cat prompt)" > log 2>&1; echo $? > exit'` (`:426-491`).
  - It also has `reattach…Session` (`:506`), `…SessionActive`, and `drop…Session` (`:541`).
  - Gemini (`src/bun/gemini-tmux.ts`) is the self-issued-session-id sibling, and codex (`codex-tmux.ts`) is the stdin-delivery (`< promptfile`) sibling.
- **`src/bun/agents.ts`.**
  - `resolveBin` switch `:300-331` (no default, so a TS error).
  - `harnessEnv` `:341-392`: its **`else` branch sets `GEMINI_CLI_HOME`**, so a new kind silently gets gemini's var.
  - `buildHarnessTerminalCommand` `:427`.
  - `buildCommand` `:479`, with kind branches at `:487/598/656/726/764`. **The trailing code is the codex branch (`:824`)**, so an unknown kind builds a `codex exec` argv.
  - `spawnAgent` `:3123`, kind branches at `:3126/3169/3207/3237/3257`. **It falls through to codex (`:3288`).** The fake-driver seams `AGETOR_<KIND>_DRIVER=fake` live here.
- **`src/bun/orchestrator.ts`** (antigravity appears 49 times):
  - Imports `:117`.
  - `reconcileOrphans` reattach key and kind gate `:797-900`.
  - Run-row init `antigravitySessionId: null` at `:1757, 3960, 4161, 4340, 4927, 5803, 6063, 6164`.
  - `onSessionId` → column mapping `:1790-1801`. **Its default arm writes `fxSessionId`.**
  - Queue drain `:2682/2725`, agent-switch drop `:2769-2776`, `sendInput` dispatch `:3747` (unknown kind → "unknown agent kind", safe).
  - Per-kind turn queue `sendAntigravityTurn`/`spawnAntigravityTurnNow`/`drainAntigravityQueue`/`findLastAntigravitySessionId` `:4448-4598`.
  - Archive drop `:6826`, delete `:7173/7198`.
  - Pre-flight 1b `minCliVersionError`.
- **Status.** `src/bun/agent-status.ts`:
  - `INSTALL_HINTS` `:17` (Record, so a TS error).
  - `BREW_PACKAGES` `:32` (Partial).
  - `upgradeHintFor` `:79` (`brew upgrade <pkg>` with **no `--cask`**, which would hit the AWS formula on this machine).
  - `probeVersion` `:88`, `probeHelp` and the fx marker `:114+`, `checkHarness` (`loggedIn`/`authHelp` fail-open pattern).
- **Discovery.**
  - `src/bun/agent-discovery.ts`: `parseAntigravityModels` `:469`, `discoverAntigravity` `:492`, `runRefresh` allSettled list `:972-985`, `runRefreshKind` switch `:1113`.
  - `src/bun/model-discovery.ts`: per-harness discovery only for fx/codex (`:62, 96, 172`).
  - `src/shared/model-options.ts` `mergeModelOptions`.
- **Persistence.**
  - The harnesses rebuild recipe is `src/bun/migrations/061_antigravity_harness.sql`: union CHECK incl. `grok`/`kimi`, `INSERT OR IGNORE` seeds, self-heal re-seed of every builtin, plus `ALTER TABLE runs ADD COLUMN antigravity_session_id`.
  - **`073_harness_profile_mcp_servers.sql` added `harnesses.profile_mcp_servers` after 061**, so a new rebuild must carry that column.
  - The latest migration is `074`; `index.ts` keeps `aliases` for renumbered ids.
  - `src/bun/db.ts`: `getByIdOrKind` `:1806`, insert kind whitelist `:1836`, runs session-id columns `:2571/2666/2710/2722`.
- **API.** `src/bun/server.ts`: harness POST kind validation `:3930-3937`; `GET /agent-models` kind map `:4905/4940`.
- **Capability discovery.**
  - `src/bun/commands.ts`: `builtinCommands` `:165`, per-kind command/skill walk `:320-390`, per-kind MCP parse `:720-760`. Gemini and antigravity fall through to *nothing*.
  - `src/bun/ref-tree.ts:300` pathspecs don't include `.github`, which Copilot's skills/MCP/agents need.
  - `src/bun/bundle.ts:313` gates `userLevelSkills` to four kinds.
- **Webview.**
  - `App.tsx:246` and `TaskLaunchPickers.tsx:185` `AgentModelMap` literals.
  - `TaskLaunchPickers.tsx:295/334`, `NewTaskForm.tsx:307-312` (per-kind seed), `:371`, `:413`, `:993` (plan-mode copy), `RunPanel.tsx:7646`.
  - `AgentIcon.tsx:8-21`: `@lobehub/icons` 5.16 ships **`GithubCopilot`** (Mono only, like Cursor and Vercel).
  - `SettingsDialog.tsx`: `isExperimentalKind` `:145`, `HARNESS_HOME_COPY` `:182-209`, kind list `:1908`.
  - `OnboardingChecklist.tsx:44` (`LOGIN_COMMAND`), `lib/api.ts:214`, `AgentProfileDetailsDialog.tsx:140`.
- **CLI.** `src/cli/commands/harness.ts:140` login hint (claude/cursor only, generic fallback).
- **Docs.**
  - `README.md` names the harnesses at `:8, 34, 44, 47, 79-84` (table), `:264` (mermaid), `:272, 294, 310-313` (env table), `:403, 413`.
  - `CLAUDE.md` "Agent command shape", the env-override paragraph and the `AGETOR_*_DRIVER=fake` list.

### 1c. Git history lessons

- **Order-dependent CHECK rebuilds once wiped a prod harnesses table** (fleet KB `867db5cf…`). The agreed convention for concurrent new-kind branches (KB decision `a1a98166…`):
  - The rebuild CHECK always lists the union of all in-flight kinds.
  - Seeds use `INSERT OR IGNORE`.
  - Whoever merges second renumbers and keeps `aliases`.
- **Retired/unmerged kinds still pass the CHECK** (`grok`, `kimi`), so every `harness.kind` consumer must tolerate a non-`AgentKind` value (KB `49246867…`).
- **Model-id migrations must kind-join** (KB `79ea4a46…`). Copilot's ids (`claude-opus-5.5`, `gemini-4-argon`, `gpt-6.1-sol`, `grok-4.7`, `kimi-k3`, …) collide with literals other kinds use, so any future normalize/retire migration for copilot rows must join on `harnesses.kind = 'copilot'`.
- **`findLast*SessionId` lookups ignore the harness id** (KB `e100e031…`), so a same-kind harness switch resumes the old account's session. A new kind copies the bug unless fixed.

## 2. What we proved

All spikes ran in the scratchpad against the real `copilot` 1.0.104 binary. They used `COPILOT_HOME=<scratch>` plus a local fake OpenAI-compatible SSE provider (BYOK: `COPILOT_OFFLINE=true COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:18765/v1 COPILOT_PROVIDER_TYPE=openai`). That meant no GitHub auth, no network and no billing.

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does `-p --output-format json` give structured, tailable JSONL? | **Yes** | 15 lines for "say hi" (`user.message` … `assistant.message` … `result {sessionId, exitCode:0}`). With a 20 s slow provider, 6 lines were already on disk at t=4 s, so it's flushed per event. | 1.0.104, macOS arm64 | `spikes/copilot-cli/work1/out1.jsonl`, `work3/flush.jsonl` |
| Can agetor self-issue the session id (gemini pattern)? | **Yes** | `--session-id 1111…` was echoed in `result.sessionId`. Re-running with the **same `--session-id`** resumed it: `session.resume` was in `events.jsonl` and prior messages were sent to the model. `--resume=<unknown>` → rc 1 "No session … matched". | 1.0.104 | `scenarios2/K_sessionid_resume.jsonl` |
| Can the prompt go via stdin (no argv cap)? | **Yes** | `echo "…" \| copilot --output-format json …` (no `-p`) ran a normal turn. `sh -c 'exec "$@" < prompt.txt > log 2>&1'` works. | 1.0.104 | `scenarios/A_stdin.jsonl`, `work3/flush.jsonl` |
| Tool events shape? | **Yes, mappable** | `assistant.message.toolRequests[]` → `tool.execution_start {toolCallId, toolName:"bash", arguments}` → `tool.execution_complete {success, result.content}`. Tool ids are stable (`call_N`). | 1.0.104 | `work1/out2.jsonl` |
| What happens on Stop (SIGINT/SIGTERM) mid-turn? | **Graceful, but rc 0** | `abort {reason:"user_initiated"}`, `assistant.idle {aborted:true}`, then `result.exitCode 0`, **process rc 0**. Agetor must not read rc 0 as success after a cancel; it already uses its own `cancelled` flag. | 1.0.104 | `scenarios/F_sigint.jsonl`, `F2_sigterm.jsonl` |
| Provider/API failure? | rc 1 | Provider 500s: 5 retries over ~16 s (`assistant.turn_retry`, `session.info "Retrying…"`), then `session.error {errorType:"query", message, statusCode:500}`, `result.exitCode 1`, **rc 1**. | 1.0.104 | `scenarios/D_fail.jsonl` |
| Not logged in? | rc 1, plain stderr | No auth, no BYOK: rc 1, stderr "Error: No authentication information found." plus remediation, empty stdout. | 1.0.104 | `work-unauth/err.txt` |
| Permissions in `-p` without allow flags? | **Mutations silently denied** | `touch` via the shell tool → `tool.execution_complete {success:false, error:"Permission denied because no interactive user response was available…"}`, the turn continues, rc 0. Read-only `echo` was auto-approved. `--allow-tool=write` doesn't cover shell. `--allow-all-tools` lets it run. | 1.0.104 | `scenarios2/J*.jsonl` |
| Is plan mode real, and does it persist? | **Yes, and yes (sticky)** | `--mode plan`: `instruction.update <plan_mode>…Save the plan to: $COPILOT_HOME/session-state/<id>/plan.md`, and the user message is prefixed `[[PLAN]]`. A follow-up **without** `--mode` stays in plan. `--mode interactive` exits ("Plan mode is no longer active"). | 1.0.104 | `scenarios2/L1-L3*.jsonl` |
| Autopilot in `-p`? | Works, costly | `--autopilot` re-prompts "You have not yet marked the task as complete…" until `task_complete` or the cap (5 continues), then `session.autopilot_stopped {reason:"cap_reached"}`. | 1.0.104 | `scenarios/E2_autopilot.jsonl` |
| Effort flag reaches the request? Validated? | Yes; **not validated under BYOK** | `--reasoning-effort high` → request `reasoning_effort:"high"`. Default is `medium` (gpt/claude-sonnet), and none for claude-haiku-4.5. `none` omits the field. haiku-4.5 + `high` was passed through. (With real Copilot, the 1.0.88 changelog says an unsupported level is "reported and left unapplied".) | 1.0.104 BYOK | fake-provider `requests.jsonl` |
| Model switch on resume? | **Yes** | Resumed session with `--model claude-sonnet-5.5` → `assistant.message.model:"claude-sonnet-5.5"`. | 1.0.104 | `scenarios2/N_model_switch.jsonl` |
| Folder trust and project config in `-p`? | **Partial without trust** | No trust: project skills (`.github/skills`, `.claude/skills`) **load**, workspace `.mcp.json` does **not** (`mcp_servers_loaded {servers:[]}`). `--trust-folder` loads it but **errors when combined with `--session-id`** ("cannot be used with '--session-id <id>'"). `COPILOT_ALLOW_ALL=true` (exact value) **trusts and works with `--session-id`**. A hanging workspace MCP server blocked the run for over 60 s. | 1.0.104 | `work-trust/*.jsonl` |
| Per-run usage numbers? | **Yes, via file** | stdout `result.usage` has only premiumRequests and durations. `--usage-output-file f.json` gives `modelMetrics.<model>.usage {inputTokens, outputTokens, cacheRead/WriteTokens}`, `totalNanoAiu`, `aiCreditsStatus`, `codeChanges`. | 1.0.104 | `spikes/copilot-cli/usage.json` |
| Is ACP viable (fx-style)? | **Yes** | `initialize` → `loadSession:true`, `authMethods[copilot-login]`. `session/new` → configOptions `mode` + `allow_all`. Mutation → `session/request_permission` (allow_once/allow_always/reject_once). Answering allow_once ran the command. `session/prompt` → `{stopReason:"end_turn", usage}`. Unauth `session/new` → `-32000 Authentication required`. | 1.0.104 | `spikes/copilot-cli/acp-byok.jsonl`, `acp-unauth.jsonl` |
| Is the model list available offline? | **Yes (static per CLI version)** | `COPILOT_OFFLINE=true copilot help config` prints the 31 model ids, no auth needed. | 1.0.104 | `help-config.txt` |
| Would the typechecker catch a half-wired kind? | **No (21 errors, 9 files)** | Scratch copy, `AgentKind \|= "copilot"`, `tsc --noEmit` → 21 errors: types.ts tables, `INSTALL_HINTS`, `AgentIcon`, `HARNESS_HOME_COPY`, `resolveBin`, `runRefreshKind`, `NewTaskForm`/`TaskLaunchPickers`/`RunPanel` map indexing. **It does not flag** `buildCommand`/`spawnAgent` (fall to codex), `harnessEnv` (falls to `GEMINI_CLI_HOME`), `onSessionId` (falls to `fxSessionId`), reconcile/send/drop dispatch, db/server kind whitelists, the migration CHECK, `commands.ts`, `ref-tree.ts` or the README. | repo @ c5cf1a2 | `spikes/tsc-copilot.txt` |

Spike artifacts live under the scratchpad: `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-df2af652-baba-46c3-a9c8-f716f686f331/ce1875c3-c452-4950-bc24-364cba936c35/scratchpad/spikes/`. That covers `copilot-cli/` (binary, help dumps, scenario outputs), `fake-provider/server.ts`, `scripts/` (scenario runners, ACP probe), and `repo-copy/`. The fake-provider recipe is reusable for a **real-binary integration test with no auth**.

## 3. What we're assuming

- **The real Copilot backend emits the same JSONL schema as BYOK runs.** The CLI's event layer sits above the provider transport, and the schema is bundled. *If wrong:* the mapper needs a live-capture pass. This is cheap to fix but needs a logged-in smoke.
- **`assistant.reasoning` appears on stdout for reasoning models** (non-ephemeral in the schema, not exercised). *If wrong:* there is no thinking stream (same parity gap as gemini), or it has to come from `assistant.message.reasoningText`.
- **A separate `COPILOT_HOME` isolates a second account.** The keychain entry is presumably keyed per host+login, and config.json records the logged-in user. Unverified with two real accounts. *If wrong:* multi-account needs a `HOME` override (the cursor/fx way) or a per-harness `COPILOT_GITHUB_TOKEN` env.
- **Real Copilot rejects or reports unknown model ids** (BYOK passed `not-a-real-model-xyz` straight through). *If wrong:* typos fail later or silently.
- **Older CLIs refuse newer model ids** (server catalog gated by client version, as with codex). *If wrong:* `MODEL_MIN_CLI_VERSION.copilot` floors are unnecessary. *If right but skipped:* users get a confusing server error.
- **Prompt mode never shows first-run interactive prompts** (none appeared with a fresh `COPILOT_HOME`). *If wrong:* the run hangs in tmux, and the death or stall paths would catch it.
- **A tmux-hosted `-p` run behaves the same as a plain redirected one.** Copilot detects `TMUX` (`COPILOT_MULTIPLEXER`), but stdout is a file, not a TTY. *If wrong:* escape sequences leak into the log, and the mapper's JSON-parse fallback would show them as stdout lines.
- **The parent's `GH_TOKEN`/`GITHUB_TOKEN` reaches the spawn** (agetor passes `PATH` plus the harness env into tmux; whether the tmux server env carries the user's tokens depends on how the per-instance server was started). *If wrong:* fine. *If right:* a classic `ghp_` token in the user's env would override their OAuth login and break auth (see Q11).

## 4. What we must ask the owner

1. **Driver architecture.**
   - **(A) tmux one-shot per turn** (`copilot -p`/stdin `--output-format json --session-id <uuid>`, a `copilot-tmux.ts` cloned from `antigravity-tmux.ts`/`gemini-tmux.ts`):
     - Survives an agetor restart (reattach while in flight) and is proven by spikes.
     - No interactive permission cards: non-auto modes can only *deny* mutations silently.
   - **(B) ACP per turn** (`copilot --acp --stdio`, a `copilot-acp.ts` modelled on `fx-acp.ts`):
     - Permission cards for an Ask mode. mode/allow_all are advertised as `configOptions`, but setting them via `set_config_option` was not exercised.
     - **No restart survival** (orphaned on quit, like fx). Public preview.
   - **(C) Hybrid** (tmux for Auto/Plan, ACP for Ask): most complete, roughly double the driver surface.
   - *Evidence favours A*, because restart-safety is a headline README promise (`README.md:34`) that every kind but fx keeps.
2. **Identity and rollout.**
   - Kind id `copilot`, label "GitHub Copilot" (or "Copilot CLI"), binary `copilot`.
   - Enabled by default like Antigravity (`061` seeds `enabled=1`) or opt-in like codex/cursor/gemini/fx?
   - Experimental badge (`isExperimentalKind`, `SettingsDialog.tsx:145`)?
   - Coordinate the kind id with the concurrent `opencode` branch (see §7).
3. **Default model.** The CLI's own default is undocumented. Candidates:
   - **`auto`**: Copilot's router, a 10% discount, cheapest-sensible. It matches the fx precedent of "per-token billing → don't default to the flagship".
   - **`claude-sonnet-5.5`**: first in the CLI's list.
   - **`gpt-6.1-sol` / `claude-opus-5.5`**: agetor's usual "best model" rule.

   Copilot now bills AI Credits per token, so the fx exemption logic plausibly applies.
4. **Curated model list.**
   - Ship all 31 ids from `copilot help config` (plus `auto`) as curated rows, or a trimmed set?
   - Add discovery by parsing `copilot help config` (offline, no auth, tracks the installed CLI version but **not** the account's entitlements or org policy)?
   - Should copilot be `CATALOG_SCOPED_KINDS`? Evidence says no, since that list isn't account-scoped.
5. **Mode mapping.**
   - Proposed:
     - **Auto** = `--allow-all` (+ `COPILOT_ALLOW_ALL=true`, see Q7).
     - **Plan** = `--mode plan` (sticky per session, so every turn must pass `--mode interactive|plan` explicitly).
     - **Read-only** = no allow flags (mutations silently denied, and the model is told why).
   - Optional extras:
     - **Assisted** = `--assisted-approval` (an LLM safety judge, the fx-`auto` analogue).
     - **Autopilot** = `--autopilot` (keeps going until `task_complete`; up to 5 extra continues per turn, which costs credits).
   - `CODE_PLAN_MODE.copilot = {code:"auto", plan:"plan"}`?
6. **Plan approval UX.** Copilot writes the plan to `session-state/<id>/plan.md` and can emit `exit_plan_mode.requested`.
   - Surface it as a plan card with Approve → switch to Auto plus "implement" (mirroring cursor's flow, `CLAUDE.md` cursor bullet) in v1?
   - Or ship plan mode as read-only planning only and defer the card?
7. **Folder trust.**
   - Without trust, the worktree's workspace MCP (`.mcp.json`/`.github/mcp.json`), hooks and repo plugins **don't load** in `-p`.
   - `--trust-folder` can't combine with `--session-id`.
   - `COPILOT_ALLOW_ALL=true` trusts *and* allows everything, which fits Auto.
   - For Plan/Read-only, either accept no workspace MCP, or persist trust via `copilot config trustedFolders <worktree>`. That mutates the user's Copilot settings, though cursor's `--trust` already persists per-path trust.
8. **Effort.**
   - The CLI accepts none…max for any model and reports/ignores an unsupported level. Options:
     - (a) offer all seven for every model;
     - (b) a curated per-family table (Claude low–max, GPT none–xhigh/max, haiku-4.5 none, …);
     - (c) collapse effort and let the CLI default (`medium`).
   - `DEFAULT_EFFORT.copilot`? Agetor needs a value, and fx's `auto` "model default" row is fx-only by construction.
9. **Logged-in pre-flight.**
   - There's no cheap status command. Options:
     - (a) fail-open `loggedIn: null`, letting the run's stderr surface "No authentication information found";
     - (b) an ACP `initialize`+`session/new` probe (accurate, but **creates a session** when logged in);
     - (c) a heuristic: an env token present, or a logged-in-user key in `$COPILOT_HOME/config.json` (the key name is unverified without a real login).
   - The onboarding login command would be `copilot login` (or `/login` inside `copilot`).
10. **Binary identity.** Add a `--version` marker check ("GitHub Copilot CLI") to reject AWS Copilot (real risk: `aws/tap` is tapped here).
    - This means tests and the e2e fixture need a stub script, not `/bin/echo` (the fx precedent, `e2e/fixtures.ts:349-363`).
    - Install hint: `brew install --cask copilot-cli` or `npm i -g @github/copilot` (Node ≥ 22)?
    - Upgrade hint: `copilot update`, or `brew upgrade --cask copilot-cli` for a cask install. **Must include `--cask`.**
11. **Ambient GitHub tokens.**
    - Copilot gives `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` precedence over the stored login, and rejects classic `ghp_` PATs.
    - Should agetor strip `GH_TOKEN`/`GITHUB_TOKEN` from copilot spawns unless the harness env sets them, or leave the CLI's documented behaviour alone?
12. **v1 scope for parity surfaces** (each is cheap to defer):
    - Thinking stream (`assistant.reasoning`).
    - Usage chip from `--usage-output-file` (tokens plus AI credits).
    - Account quota in the usage tracker (`USAGE_SUPPORTED_KINDS`).
    - Subagent rendering (`subagent.*`, `parentToolCallId`).
    - TODO tracker (`session.todos_changed` is signal-only, and the data lives in SQLite).
    - Capability discovery for `/` autocomplete and the Extensions picker (Copilot's skill/MCP/agent dirs, plus adding `.github` to `ref-tree.ts` pathspecs).
    - A `HARNESS_TEMPLATES` additional-account entry (Antigravity is also missing one).
    - Per-model `MODEL_MIN_CLI_VERSION.copilot` floors from the changelog.
13. **Commit trailer.** Copilot adds `Co-authored-by` to agent commits by default. It's settings-only, with no flag.
    - Leave it as the user's Copilot config decides?
    - Or have agetor write a repo-local `.github/copilot/settings.local.json`? That's invasive.
14. **Auto-update.** Cask and standalone installs download updates on launch.
    - Leave it alone (recommended), or pass `--no-auto-update` so a run never switches versions mid-task?

## 5. Completeness inventory

- **Callers (direct and indirect) to extend or guard:**
  - **Types:** `src/shared/types.ts` — `AgentKind` `:296`, `DEFAULT_MODEL` `:2511`, `DEFAULT_EFFORT` `:2584`, `CATALOG_SCOPED_KINDS` `:2583`, `MODEL_MIN_CLI_VERSION` `:2638`, `CODE_PLAN_MODE` `:3099`, `MODEL_EFFORT_SUPPORT` `:3186`, `MODEL_MODE_DENY` `:3537`, `AGENT_OPTIONS` `:3597`, `Run.copilotSessionId?` (near `:3951`), `HARNESS_TEMPLATES` `:985`, `USAGE_SUPPORTED_KINDS` `:1829` (if quota is in scope), and the `Harness.home` doc comment `:311-335`.
  - **New driver:** `src/bun/copilot-tmux.ts` (or `copilot-acp.ts`) plus its test.
  - **`src/bun/agents.ts`:**
    - `resolveBin` `:300` (`copilot`, `AGETOR_COPILOT_BIN`).
    - `harnessEnv` `:341`: **explicit `COPILOT_HOME=<home>` branch**, because the else currently means gemini.
    - `buildHarnessTerminalCommand` (covered by `harnessEnv`).
    - `buildCommand` `:479`: **explicit branch before the codex fallthrough** (`AGETOR_COPILOT_ARGS`).
    - `spawnAgent` `:3123`: **explicit branch plus the `AGETOR_COPILOT_DRIVER=fake` seam**.
    - `makeFakeAgent` kind options.
  - **`src/bun/orchestrator.ts`:** import, `reconcileOrphans` key and kind gate (`:797-900`), every run-row init `…SessionId: null`, the `onSessionId` mapping (`:1790`, **fix the fx default arm**), queue drain sites (`:2682/2725`), agent-switch drop (`:2769-2776`), `sendInput` dispatch (`:3747`), the new `sendCopilotTurn`/`spawnCopilotTurnNow`/`drainCopilotQueue`/`findLastCopilotSessionId`, archive drop (`:6826`), delete (`:7173/7198`), and `minCliVersionError` if floors are in scope.
  - **`src/bun/agent-status.ts`:** `INSTALL_HINTS`, `BREW_PACKAGES` (**cask-aware upgrade string**), `upgradeHintFor` (`copilot update`), a version-marker probe, and the `loggedIn` strategy.
  - **Discovery:** `src/bun/agent-discovery.ts` (`discoverCopilot` plus `parseCopilotModels` from `help config`, `runRefresh` list/kinds array `:972-985`, `runRefreshKind` `:1113`, exports `:1210`). Also `src/bun/model-discovery.ts` (only if per-harness discovery) and `src/shared/model-options.ts` (no change unless catalog-scoped).
  - **Persistence:** `src/bun/db.ts` — `getByIdOrKind` `:1806`, insert whitelist `:1836`, `RunRow`/`toRun`/`runs.insert`/`runs.update` session-id column `:2571/2666/2710/2722`.
  - **API:** `src/bun/server.ts` — harness POST kind validation and its error copy `:3930-3937`, `/agent-models` maps `:4905/4940`.
  - **Capability discovery:**
    - `src/bun/commands.ts`: user/project skill dirs (`~/.copilot/skills`, `~/.agents/skills`, `.github/skills`, `.agents/skills`, `.claude/skills`) and MCP (`~/.copilot/mcp-config.json`, `.mcp.json`, `.github/mcp.json`).
    - `src/bun/ref-tree.ts:300` (add `.github`).
    - `src/bun/bundle.ts:313` (`userLevelSkills` kind gate).
  - **Webview:** `src/mainview/App.tsx:246`, `components/kanban/TaskLaunchPickers.tsx:185`, `NewTaskForm.tsx:307-312, 371, 413, 993`, `RunPanel.tsx:7646` (plus any kind-gated chips such as usage/plans `:4157`), `AgentIcon.tsx` (`GithubCopilot`), `AgentProfileDetailsDialog.tsx:140`, `settings/SettingsDialog.tsx:145, 182-209, 1908`, `onboarding/OnboardingChecklist.tsx:44`, `lib/api.ts:214`.
  - **CLI:** `src/cli/commands/harness.ts:140` (login hint), `src/cli/commands/add.ts` (kind pickers read `AGENT_OPTIONS`, so no change expected; verify), `src/cli/commands/harness.ts` add/edit `--kind` validation (server-side).
- **Propagation surface:**
  - **Migration `075_copilot_harness.sql`:** a harnesses rebuild with the union CHECK `('claude-code','codex','cursor','grok','gemini','kimi','fx','antigravity','opencode','copilot')`, copying **`profile_mcp_servers`**, `INSERT OR IGNORE` builtin seed plus self-heal re-seed, and `ALTER TABLE runs ADD COLUMN copilot_session_id TEXT`.
  - Register it in `src/bun/migrations/index.ts` and update the last-migration assertion in `src/bun/migrate.test.ts`.
  - Bundle import/export: `src/shared/bundle-import.ts` `knownKinds`, which derives from `AGENT_OPTIONS`; verify.
  - `parseAgentProfileSnapshot` derives kinds from `AGENT_OPTIONS`, so it's automatic.
- **Existing data to backfill:** none. It's a new kind with a new nullable column. The builtin row is seeded by the migration. No model-id normalisation is needed.
- **Docs / config / examples:**
  - `README.md` `:8, 34, 44, 47, 79-84, 264, 272, 294, 310-313, 403, 413`.
  - `CLAUDE.md`: Agent command shape bullet, the env-override list (`AGETOR_COPILOT_BIN/ARGS/DRIVER`), and the `Harness.home` multi-account notes.
  - The new plan docs under `docs/plans/`.
- **Tests that pin per-kind lists** (expect edits): `src/bun/migrate.test.ts`, `src/bun/harnesses.test.ts`, `src/shared/types.test.ts`, `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`, `src/bun/agent-status*.test.ts`, `src/bun/agent-discovery*.test.ts`, `src/shared/speed.test.ts` (copilot → `["off"]`), plus the e2e fixture env (`e2e/fixtures.ts:325-380`).
- **What the change would orphan:** nothing. It's purely additive.

## 6. Runnability

- **Start locally:**
  - `bun run dev:hmr` (UI) or `bun run build && bun run dev`. Both use `AGETOR_DATA_DIR=~/.agetor-dev`; never point unmerged builds at `~/.agetor` (memory: dogfood in the dev dir).
  - This worktree has **no `node_modules`**: run `bun install` first, with `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- **Tests:** `bun run typecheck` (green at `c5cf1a2` in a scratch copy), `bun test` (single file: `bun test src/bun/<file>.test.ts`). Known pre-existing failures: tmux-socket ×2 and a reconcile cancel test.
- **E2E:**
  - Playwright via `bun node_modules/@playwright/test/cli.js test e2e/<spec>`. Run one Playwright process at a time.
  - Fixtures: `e2e/fixtures.ts`, which starts a headless backend per worker with `AGETOR_<KIND>_DRIVER=fake` seams.
  - A copilot e2e would add `AGETOR_COPILOT_DRIVER=fake` plus a `copilot` stub script if the version marker is adopted.
- **Live smoke:**
  - Copilot isn't installed or logged in on this machine. It needs the owner to `brew install --cask copilot-cli` (or npm) and `copilot login`, and it spends AI Credits.
  - **A zero-cost alternative exists:** the BYOK fake-provider recipe in §2 drives the *real* binary end to end offline. It could back an opt-in integration test (gate on `AGETOR_COPILOT_REAL_BIN` or a bin lookup) that checks the mapper against real output.

## 7. Risks & blast radius

- **Silent fallthroughs.** `buildCommand`/`spawnAgent` → codex, `harnessEnv` → `GEMINI_CLI_HOME`, `onSessionId` → `fxSessionId`. A half-wired copilot task would launch **codex**, write the wrong session column, or isolate the wrong account, and typecheck stays green.
  - Recommend explicit branches plus `never`-exhaustive throws in these four places as part of the change. The kimi branch did this but never merged.
- **Concurrent kind branch (`feature/add-opencode-harness`, agent `warm-harbor-c421`).** It also needs a harnesses rebuild at 075. Agreed by fleet message: both CHECKs list `opencode` *and* `copilot`, carry `profile_mcp_servers`, seed with `INSERT OR IGNORE`, and the second to merge renumbers with `aliases`. Getting this wrong fails the migration transaction on user DBs. That has happened before and wiped a harnesses table.
  - Both branches also edit the same `Record<AgentKind>` tables, so expect textual merge conflicts.
- **Cancel exits 0.** The driver must resolve a killed turn as cancelled or failed. That works if, like antigravity, `kill()` resolves the session itself (`killAntigravityState` → `resolveSession(state, 1)`). Don't trust `result.exitCode` after an `abort` event.
- **`assistant.turn_end` fires per model sub-turn.** Only `result` (or process exit) ends a run. Mapping `turn_end` to "done" would truncate tool-using turns.
- **Plan mode is sticky** across resumed turns. Every spawn must pass `--mode`, including the default `interactive`, or a task switched Plan → Auto keeps planning.
- **Read-only mode reports success** while every mutation is denied (rc 0). Users may read "succeeded" as "changed files". The mode copy should say so.
- **Trust under Auto** (`COPILOT_ALLOW_ALL=true`) loads the worktree's workspace MCP servers and hooks. A hanging MCP server stalls the turn (the spike stalled for over 60 s). That's the same exposure the interactive CLI has, but agetor surfaces it as "Agent is working…".
- **Ambient tokens.** A classic `ghp_` in the user's `GITHUB_TOKEN`/`GH_TOKEN` would override their OAuth login and fail auth (Q11).
- **AWS Copilot name clash**, on PATH and in Homebrew; see Q10.
- **Contract drift.** The CLI ships near-daily and auto-updates itself. Pin to the bundled `session-events.schema.json` semantics, keep the mapper tolerant (unknown types ignored), and re-verify per release, as the fx notes in CLAUDE.md do.
- **Costs.** Autopilot (up to 5 continues per turn) and flagship defaults spend AI Credits. `--max-ai-credits` exists if the owner wants a guardrail.
- **Secret redaction.** Copilot redacts the values of `--secret-env-vars`, plus `GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` by default, inside `--output-format json`. The spike saw a short BYOK key value redacted as a substring of normal text. That's harmless for agetor, but transcripts can show `******`.
- **`findLast*SessionId` ignores the harness id** (KB `e100e031…`). A copilot task switched between two copilot harnesses (accounts) would try to resume a session that lives in the other `COPILOT_HOME`. `--session-id` would then silently start a *fresh* session with no context (create-or-resume semantics), where `--resume` would fail loudly. Decide which flag to use for follow-ups with this in mind.
