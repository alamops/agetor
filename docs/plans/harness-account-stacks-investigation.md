# Investigation — Harness account stacks (backup accounts, automatic failover)

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Change | Let a user stack several accounts of the same harness kind into an ordered train, keep a task running when the active account hits its usage/provider limit, automatically continue on the next account, and show a visible message in the task transcript — without losing the conversation, task configuration, tools/MCP/skills or each account's own authentication. |
| Agents | Inline only — this pipeline step explicitly forbids sub-agents. Three load-bearing scratchpad spikes were run directly (Claude, Codex, OpenCode). |
| Flags | none (spikes enabled) |

> **Read this first.** The user-visible requirement is short; the hard part is that Agetor's "multi-account" model deliberately isolates each account's CLI home, so the conversation, user-level MCP servers, user-level skills and CLI settings are **not** shared today. The feature is therefore two features in one: (a) a failover/routing policy, and (b) a per-kind session + capability migration between isolated account homes. The investigation separates them so the grill can decide how much of (b) is in v1.

---

## 1. What we know

### 1.1 The contract

- **Outside the repo: the pipeline step text only.** There is no PRD/spec for this feature. The task says: backups for the same harness, automatic swap when the primary reaches its limits, preserve history/tools/config/MCP/auth/APIs/skills, show a message inside the task messages, execution keeps running, multiple accounts stackable for one harness. The plan should turn the grill decisions into an in-repo spec/PRD or a binding plan section; a reviewer cannot check code against a chat message.
- The repo's own vocabulary matters here: `agent`/`--agent` is a **harness id** (the account row), while "Agent" in the UI means an **agent profile**. See `docs/architecture/agent-profiles.md:8-10`. This brief calls a member an **account** (a `harnesses` row) and the group a **harness stack**.

### 1.2 Current multi-account model (what "multiple accounts" means today)

- A harness is a row in `harnesses`; a built-in harness's `id` equals its `AgentKind` (`claude-code`, `codex`, …) and an additional account is an alias row of the same kind. `Harness` type and the per-kind `home` semantics: `src/shared/types.ts:333-405`.
- `home` maps to a different env var per kind (`src/bun/agents.ts:427-509`):
  - `claude-code` → `CLAUDE_CONFIG_DIR=<home>` (real `HOME` preserved — macOS keychain constraint).
  - `codex` → `HOME=<home>` **and** `CODEX_HOME=<home>/.codex`.
  - `cursor` → `HOME=<home>`.
  - `gemini` → `GEMINI_CLI_HOME=<home>`.
  - `fx` → `HOME=<home>`.
  - `antigravity` → `HOME=<home>`.
  - `opencode` → `HOME=<home>` plus `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` under it.
  - `copilot` → `COPILOT_HOME=<home>`.
- The Add-harness templates pre-fill those homes: `HARNESS_TEMPLATES` at `src/shared/types.ts:1163-1260`; the UI copy for each kind's home is in `SettingsDialog.tsx` (`HARNESS_HOME_COPY`, `src/mainview/components/settings/SettingsDialog.tsx:183-222`).
- `GET /harnesses` returns every row plus a probe status per row (`src/bun/server.ts:4255-4389`; `HarnessStatus` at `src/shared/types.ts:1035-1130`). `checkAllHarnesses()` probes all rows concurrently (`src/bun/agent-status.ts:868`), with a 60-second status cache (`agent-status.ts:404-435`).
- `harnesses.delete` refuses deletion while tasks or agent profiles reference the row (`src/bun/db.ts:2219-2245`); `HarnessInUseError` carries task ids and profile ids (`db.ts:2052-2068`).
- **Consequence:** an additional account is a *different CLI installation state*, not a second credential slot on one state. The CLI's user-level config, history, MCP servers, skills, plugins and settings live in that isolated home. The project/worktree (`.mcp.json`, `.claude/skills`, `.codex/skills`, …) is shared because every account runs in the same task worktree; **user-level** entries are not.
- Capability discovery reads the selected harness's own user roots: `commands.ts` `userSelectors` (`src/bun/commands.ts:425-482`) and `discoverMcpAndPluginExtensions` (`commands.ts:1102-1180`). Claude user commands/skills come from `<CLAUDE_CONFIG_DIR>`, cursor/fx/opencode from `<HOME>`, copilot from `$COPILOT_HOME`, etc. **User-level MCP/skills are per account.**
- Five kinds override the whole `HOME` for an additional account (`codex`, `cursor`, `fx`, `antigravity`, `opencode`). That means `~/.gitconfig`, `~/.ssh`, `~/.config/gh`, `~/.npmrc` and every other user-level tool config are **not** visible to that account. `claude-code`, `gemini` and `copilot` keep the real `HOME` and only redirect their own config var. This is an existing, undocumented multi-account limitation and becomes much more visible when a task silently moves from a built-in account to a HOME-overridden backup.

### 1.3 How a task resolves its harness

- `Task.agent` stores the harness id (`src/shared/types.ts:1621-1634`); `Run.agent` stores the harness id the run launched under (`types.ts:4492-4500`). Legacy rows store the bare kind and resolve through the built-in.
- `resolveHarness(harnessId)` is a thin `harnesses.getByIdOrKind` wrapper (`src/bun/orchestrator.ts:90-99`); `getByIdOrKind` also synthesizes a built-in for a missing kind id (`src/bun/db.ts:2123-2165`).
- `taskHarnessId(task)` resolves the current id (`orchestrator.ts:6127-6134`).
- `startTaskInner` resolves the task's agent profile first, then the harness, then checks enabled/available/logged-in/CLI floor, prepares the worktree, inserts the run row with `agent: task.agent`, and spawns (`orchestrator.ts:2009-2600`). A disabled harness refuses new runs; an in-flight run is unaffected (`types.ts:390-404`).
- Follow-ups (`sendInput`, `orchestrator.ts:4494`) re-read the task and dispatch by `resolveHarness(task.agent)?.kind`; queued follow-ups are per-kind maps and are drained after a run settles (`orchestrator.ts:3488-3512`).
- A manual agent change goes through `PATCH /tasks/:id` (`server.ts:5657-5700`) and `reconcileTaskSession` (`orchestrator.ts:3631-3735`): **any** harness-id change kills the old session and drops every queued follow-up; a same-kind alias change keeps model/mode/effort, a cross-kind change resets them. The UI's `RunPanel` `AgentSelect` (`RunPanel.tsx:8261`) and `NewTaskForm` harness grid (`NewTaskForm.tsx:933-990`) store a single harness id.
- Agent profiles store one `harness` (`src/shared/types.ts:433-475`) and freeze a snapshot after the first run (`types.ts:476-497`; `orchestrator.ts:1814-1865`). Pipelines bind each step to an `agentProfileId` (`types.ts:509-541`) and create each step task with `agent: profile.harness` (`src/bun/pipeline-runner.ts:1370`). Bundles export only a harness `{id, kind, label}` reference, never accounts or their homes (`src/shared/bundle.ts:60-80`, `src/bun/bundle.ts:64`, `:160`).
- **Consequence:** a stack can be made to follow `Task.agent` changes without touching profiles/pipelines **if** stack membership is a property of the account (implicit model). If stacks are explicit entities, `Task`, `AgentProfile`, pipeline snapshots and bundle formats all need a new reference.

### 1.4 Session continuity today — per kind

Agetor stores one session-id column per kind on `runs` (`SESSION_ID_COLUMNS`, `src/bun/db.ts:2917-2927`; `sessionIdPatchFor`, `orchestrator.ts:3064-3079`). Resume is deliberately scoped to the harness that created the id:

- `findLastSessionIdForHarness(taskId, column, harnessId)` (`orchestrator.ts:6146-6168`) returns the newest id **only across runs whose `agent` resolves to that harness**. Switching a task to a second account of the same kind therefore starts fresh; switching back resumes the original. This is pinned by `src/bun/orchestrator-session-harness.test.ts` and stated as a repo rule in `CLAUDE.md:99`.
- `reconcileTaskSession` treats any harness-id change as a session-killing event (`orchestrator.ts:3631-3665`) — the HOME/env block changes, so the on-disk session and login differ even for a same-kind alias.
- Per-kind state and resume mechanism:
  - **claude-code** — `CLAUDE_CONFIG_DIR=<home>` or `~/.claude`; transcript at `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl` (`jsonlPathFor`, `src/bun/claude-tmux.ts:3431-3445`), plus `<sessionId>/subagents`, `<sessionId>/tool-results` and `<sessionId>/mcp-tasks` sidecars (Anthropic's `.claude` directory reference documents these; `docs/architecture/harness-claude-code.md` covers the driver). Launch/resume via `--resume <id>` (`src/bun/agents.ts:648-652`). On resume the tailer parks at EOF (`resumeJsonlOffset`, `claude-tmux.ts:8337`) so the old transcript isn't re-emitted. Auth for an alias lives in `<home>/.credentials.json`; the built-in uses the macOS Keychain (`src/bun/usage/creds.ts:44-105`, `:138-190`).
  - **codex** — `CODEX_HOME=<home>/.codex` (plus `HOME`); rollouts under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`; resume via `codex exec resume <thread_id>` (`docs/architecture/harness-codex.md:6-8`); id in `runs.codex_session_id`. Auth in `<CODEX_HOME>/auth.json` (`src/bun/usage/codex-usage.ts:58-95`); config/MCP in `config.toml`.
  - **cursor** — ACP; `session/load` of `runs.cursor_session_id` (`docs/architecture/harness-cursor.md:8-12`); HOME override; local chat stores under `~/.cursor/chats/<project-hash>/<session-id>/` (`store.db` + `meta.json` observed on this machine).
  - **gemini** — one-shot `gemini --resume <uuid>`; id self-issued and stored in `runs.gemini_session_id` (`docs/architecture/harness-gemini.md:5-12`); state under `GEMINI_CLI_HOME`.
  - **fx** — ACP `session/resume` (fallback `session/load`) of `runs.fx_session_id` (`docs/architecture/harness-fx.md:34-38`); state under `~/.fx/sessions/<id>/` (`session.json`, `events.jsonl`, `permissions.json`, `usage-v2.json` observed); HOME override.
  - **opencode** — one agetor-owned `opencode serve` per harness, session `ses_…` stored in `runs.opencode_session_id`; follow-up `-s <id>`; state in `<XDG_DATA_HOME>/opencode/opencode.db` (`session_v2`, `session_message`) and server state in `dataDir/opencode-servers/<harnessId>.json` (`docs/architecture/harness-opencode.md`).
  - **copilot** — one-shot `copilot --session-id <uuid>`; `runs.copilot_session_id`; `COPILOT_HOME/session-state/<id>/` (docs `harness-copilot.md:7-20`, `:60-62`).
  - **antigravity** — one-shot `agy --conversation <id>`; `runs.antigravity_session_id`; HOME override (`docs/architecture/harness-antigravity.md:6-9`).
- **Consequence:** a same-kind stack can share a conversation only if the new account's provider state is migrated or referenced. The id alone is not enough; each kind's lookup is home-scoped.

### 1.5 Limit / usage signals today

- **No cross-kind "account exhausted" concept exists.** `HarnessStatus` has availability, login and Claude local token rollups, not quota (`types.ts:1035-1130`). Quota is a separate `HarnessQuota` snapshot (`types.ts:1141-1160`), stored per harness in `harness_usage` (`src/bun/migrations/043_harness_usage.sql`) and polled every 10 minutes (`USAGE_POLL_SWEEP_MS`, `types.ts:2047`; `pollAllUsage`, `src/bun/usage/poller.ts:172-198`; the webview's 15s `/harnesses` poll is only availability).
- **Only three kinds have a usage provider:** `claude-code`, `codex`, `cursor` (`USAGE_SUPPORTED_KINDS`, `types.ts:2064`; `USAGE_PROVIDERS`, `poller.ts:43-48`). Gemini, fx, antigravity, opencode and copilot have no live quota provider.
- Claude providers read the OAuth usage endpoint, falling back to `.claude.json`'s `cachedUsageUtilization` (`src/bun/usage/claude-usage.ts:333-380`); codex reads `wham/usage` or the newest rollout's `rate_limits` (`src/bun/usage/codex-usage.ts:407-476`); cursor scrapes the Cursor web session (`src/bun/usage/cursor-usage.ts:674-760`). All fail soft to `status: "error"|"unavailable"`.
- Quota meters are provider-shaped: Claude session/weekly/model-scoped/extra-usage; codex session/weekly/credits/model-scoped; cursor plan/on-demand (`HarnessQuota` doc, `types.ts:1141-1160`). `QuotaMeter.scope` is a display name (e.g. "Opus"), not an exact model id.
- **Reactive limit paths that already exist:**
  - Claude: a synthetic `isApiErrorMessage` line (529, 400, 429, …) emits `CLAUDE_API_ERROR_STATUS_PREFIX` (`claude-tmux.ts:766-781`, `:1489-1505`); the orchestrator flips the task to `blocked` with reason `api-error` (`orchestrator.ts:2860-2978`). Claude's own usage-limit auto-continue notice ("Usage limit reached · continuing automatically …") is deliberately **not** carded (`claude-tmux.ts:6574-6586`); the turn stays in flight and Claude resumes itself at reset. There is no persisted event for that notice.
  - fx: `_meta.fx.modelResponseRecovery` → `FX_RECOVERY_STATUS_PREFIX` (`shared/types.ts:147-247`, `src/bun/fx-acp.ts:2125-2170`); a resumable pause makes the run fail and `noteFxRunSettled` records/schedules an auto-resume **on the same account** (`orchestrator.ts:7011-7154`, `:7066-7154`; cap `FX_AUTO_RESUME_MAX = 3`, `types.ts:2547`). `Task.fxRecovery` is the persisted paused state (`types.ts:1912-1931`).
  - OpenCode: provider/turn errors become `opencode: <message>[ — quota hint]` status lines (`src/bun/opencode-events.ts:199-210`, `:290-295`); `opencodeQuotaHint` recognizes 402/insufficient-funds for Zen models (`src/shared/opencode.ts:183-197`).
  - Codex/Gemini/Antigravity/Copilot/Cursor: failures surface as `stderr` or a status line; no structured limit channel. Codex `turn.failed`/`error` carries only `{message}` (`src/bun/codex-tmux.ts:87-108`, `:141-149`). Copilot `session.error` carries `message`/`remediation` (`src/bun/copilot-tmux.ts:589-596`). Cursor ACP `fail(message)` emits status+stderr (`src/bun/cursor-acp.ts:428-445`).
- **Consequence:** proactive selection can only be done for claude/codex/cursor; for the other five the feature must be reactive (or add a new signal per driver). A 429/402 text classifier is feasible but per-kind.

### 1.6 What happens on a failure today

- Claude API error → task `blocked` (reason `api-error`), run `failed` (`orchestrator.ts:2960-2978`, `:3307-3450`).
- Session death → `blocked` (`session-died`); unknown slash command → `blocked`; fx pause → run `failed` + Ready + auto-resume; other failures → run `failed` and task `ready`.
- There is **no automatic retry on a different account** and no account-level cooldown. The user must click Run again or switch harness manually, which kills the old session (`reconcileTaskSession`).
- `attachDoneHandler` (`orchestrator.ts:3307`) is the natural seam for a swap: it computes `newStatus`, updates the run, decides the column, emits `run-status`, runs fx settlement, then drains follow-up queues. Any swap must fit there without double-settling, double-notifying, or draining the queue into a competing turn.

### 1.7 Profiles, pipelines, bundles (the propagation surface)

- Agent profiles store one `harness`; a free-text `instructions` + `skills` list is injected into the launch prompt as `<agent_instructions_defined_by_the_user>` (`src/shared/agent-profile.ts:92-125`). Skills are only names (`/foo`); Agetor never validates the skill exists (`docs/architecture/agent-profiles.md:50`), so a backup account without that user-level skill will be told to use a skill it cannot load.
- Profiles are frozen at the first run: `effectiveAgentProfile` returns live until `runs.countForTask > 0`, then the snapshot (`orchestrator.ts:1814-1865`; `types.ts:476-497`). A stack that changes `task.agent` after the first run does not change the frozen snapshot's `harness` — a UI/display mismatch to handle.
- Pipelines create hidden step tasks with `agent: profile.harness` and an `agentProfileId` (`pipeline-runner.ts:1370-1387`); the parent task is agent-less. A stack must work per step task, not on the parent.
- Bundles export Agents/Pipelines and a harness `{id, kind, label}` reference only; the import planner falls back to the built-in kind when the account is missing (`src/shared/bundle.ts:60-80`, `:643-680`; `src/bun/bundle.ts:64`, `:383-420`; `src/shared/bundle-import.test.ts:112-230`). Stacks themselves are not portable.

### 1.8 UI / CLI surfaces that select or show an account

- New Task: `NewTaskForm.tsx:933-990` lists every enabled harness as a flat grid; `TaskLaunchPickers.tsx` renders the same for other launch dialogs; `AgentProfilePicker` replaces the block when a profile is selected (`TaskLaunchPickers.tsx:437-620`).
- Settings: `SETTINGS_SECTIONS` (`src/mainview/lib/settings-dialog-view.ts:3-12`), Harnesses section (`SettingsDialog.tsx:1487-1635`), default harness picker (`SettingsDialog.tsx:1194`), Add-harness templates/editor (`SettingsDialog.tsx:568-900`), account usage table (`SettingsDialog.tsx:1642`).
- Run panel: `AgentSelect` (`RunPanel.tsx:8261`), task details harness row; `RunPanel` is one long-lived instance with per-task reset rules (`CLAUDE.md:112`).
- Topbar: one usage/availability chip per enabled harness (`App.tsx:756-777` per the usage plan; current usage state `App.tsx:278-280`, event handler `:1350`).
- CLI: `agetor harness ls/add/edit/enable/disable/rm/shell` (`src/cli/commands/harness.ts`), `agetor add` harness/profile pickers (`src/cli/commands/add.ts:550-720`), `agetor profile`, `agetor show/ls` agent column. API client types in `src/cli/api-client.ts`; webview client `src/mainview/lib/api.ts:522` (`HarnessesPayload`) and `:620-654`.
- Routes: `ROUTE_POLICY` entries `/usage`, `/harnesses`, `/harnesses/:id`, `/harness-discovery` at `src/bun/route-policy.ts:290-300`; server handlers at `src/bun/server.ts:4247-4500`, `:5198-5271`.

### 1.9 Runtime & trust shape

- One Bun core owns the SQLite DB and the localhost API at a time; the desktop app and a background/headless core hand the API port over (`docs/architecture/always-on-host.md`, `boot-gate.ts`, `app-takeover.ts`). A swap must survive a core restart/handoff.
- Many tasks and pipeline steps run concurrently; each task has at most one in-flight run (the fold/queue invariants in `docs/architecture/harness-claude-code.md` and each one-shot driver). A swap is a new run on the same task/worktree, so it must preserve that invariant.
- No sandbox: agents run with the user's full shell privileges in the task workdir. Harness homes are agent-writable. The core must read/write them through the no-follow helpers and, while disclaiming, through disclaimed children (`docs/architecture/security.md:62-67`; `CLAUDE.md:89`). A feature that copies session/config bytes between homes is in this trust boundary and must reject symlinks/FIFOs/non-regular files, write atomically, and never copy credential files.
- Every spawn goes through `coreSpawn` (`src/bun/core-spawn.ts`); `childEnv` only scrubs `AGETOR_API_TOKEN` (`core-spawn.ts:36-62`). Provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) set in Agetor's own process environment are **inherited by every harness** unless the harness's env overrides them. This can silently make every account use one API key — a cross-account auth leak to account for when defining "auth tokens preserved".
- Two tokens: master (webview) and CLI (any same-user process can read `~/.agetor/agetor-core.json`). Agents can call `app+cli` routes. Session files and harness homes are agent-writable; a planted transcript could be copied into another account's home if the copy path is not validated.
- The app is local-first; no cloud relay, no telemetry.

### 1.10 Standards that apply (repo rules that bear on this change)

- **Session ids are scoped to the harness that created them** — `CLAUDE.md:99`; `findLastSessionIdForHarness` (`orchestrator.ts:6146`); pinned by `orchestrator-session-harness.test.ts`. A stack that shares a conversation across accounts is a deliberate exception to this rule and must be stated as such in the docs.
- **Agetor never adds its own text to a user message** — `CLAUDE.md:92`; the only machine-added text today is the references heading, the agent-instructions wrapper, the issue warning, the pipeline step prompt and the handoff reminder. A synthetic "continue on backup" prompt is a new exception and needs an explicit owner decision.
- **Server-managed task columns are skipped by the generic `tasks.update` SET clause** (watermarks, `sent_files`, `fx_recovery`, `agent_profile*`, pipeline fields, `checkout_branch`, imported-session fields) — `CLAUDE.md:97`; `docs/architecture/persistence.md:10-25`. If a stack adds a task-level state, it must follow that pattern or be a normally patchable field with a deliberate decision.
- **Never edit an applied migration; renumber with `aliases` when a concurrent branch took the number; a `harnesses` table rebuild is high-risk and must copy every column** — `docs/architecture/harnesses.md:43-51`, `docs/architecture/persistence.md:22-31`; latest migration is `083` (`src/bun/migrations/index.ts`). A new table (like `harness_usage`/`harness_auto_enabled`) is strongly preferred for stack/cooldown state; avoid a `harnesses` rebuild unless a new column is unavoidable.
- **Every route needs a `ROUTE_POLICY` entry or the server throws at startup** — `CLAUDE.md:86`; `src/bun/route-policy.ts`; `route-policy.test.ts`.
- **Every spawn goes through `coreSpawn`/`coreSpawnSync`; agent-writable files are read no-follow; task-dir I/O uses `task-dir-fs`; `src/shared` has no runtime imports from either process** — `CLAUDE.md:87-89`.
- **Every `run_events` query must SEARCH** — `CLAUDE.md:98`; `db-run-events-plans.test.ts`.
- **Tests that mutate harness rows must `snapshotHarnessState()` and restore in `afterAll`** — `docs/architecture/persistence.md:42-44`; `src/bun/test-harness-state.ts`. A new stack table needs the same hygiene.
- **The Bun main thread is shared** — large session copies/export/import must be async/cooperative (`CLAUDE.md:104`).
- **WKWebView connection budget** — don't add another SSE stream (`CLAUDE.md:105`).
- **RunPanel is one long-lived instance**; new per-task state needs a reset line (`CLAUDE.md:112`).
- **CLI/TUI free text goes through `terminal-text.ts`** (`CLAUDE.md:106`) — account labels and error text in the swap message must be escaped.
- **Docs and README must be updated with the behavior** — `README.md:44` ("many accounts"), `:87` (harness enable/extra accounts), `:137-138` (Copilot second account), `:196` (bundle portability).

---

## 2. What we proved (spikes)

All spikes ran in a scratchpad under `$TMPDIR` with `env -i`, temp `HOME`/config dirs, and no real provider credentials. Artifacts were deleted after recording because they contained local session data; the commands are reproducible and the verdicts below are the evidence.

| # | Question | Verdict | Evidence | Versions | Artifact |
| - | --- | --- | --- | --- | --- |
| S1 | Can `claude --resume` read a transcript from a **different** account's `CLAUDE_CONFIG_DIR`, and does it write the updated transcript where the new account's tailer will find it? | **Yes — proven end-to-end** | With `HOME=<tmp>`, `CLAUDE_CONFIG_DIR=<tmp>/cfgB`, and a copied transcript at `<cfgB>/projects/<encoded-cwd>/<sid>.jsonl`, `claude --resume <sid> --permission-mode bypassPermissions -p "reply ok"` returned `ok` against a local fake `/v1/messages`. The fake server logged `messages: user:Say hello briefly. \|\| assistant:Hello. \|\| user:<system-reminder>` — the prior conversation was sent to the model. The B transcript grew from 1,069 B to 250,764 B and contained `Say hello briefly`, `Hello.` and `ok`. A bogus path printed `No conversation found with session ID: …`. | claude 2.1.319; Bun fake API | Scratchpad deleted |
| S2 | Does `codex exec resume <thread_id>` find a rollout copied into a **fresh** `CODEX_HOME`? | **Yes — resume resolution proven** | Copied `rollout-…-<uuid>.jsonl` into `<tmp>/.codex/sessions/2025/10/17/`; `codex exec resume <uuid> --json -` emitted `{"type":"thread.started","thread_id":"<same uuid>"}` then a 401 (no credentials). An unknown UUID printed `thread/resume failed: no rollout found for thread id …`. No `thread_history_1.sqlite` was needed in the fresh home. | codex-cli 0.166.0 | Scratchpad deleted |
| S3 | Can an OpenCode session be moved between accounts without losing the conversation? | **Yes — export/import works, but round-trip is not a merge** | `opencode session export <ses_…>` produced 1,344,895 B; `opencode session import <file> --standalone --directory <cwd>` into fresh `XDG_*` dirs printed `Imported session: <same ses_…>`; the fresh `opencode.db` had 1 `session_v2` row and 78 `session_message` rows with the same id. A second import of the same file printed `Session already exists` (no duplicate, no merge). `--directory` rewrote the imported session's `directory`. The export JSON had only `info` + `messages` — no child sessions. | opencode 2.1.3 | Scratchpad deleted |
| S4 | Do the other five kinds (cursor, gemini, fx, copilot, antigravity) allow the same state transfer? | **Unproven** | State locations are documented (see §1.4), but no copy/load spike was run: cursor may be server/cloud-bound; fx/gemini/copilot/antigravity are likely local file copies, but their CLIs may validate account/provider/session ownership. | — | — |
| S5 | Would the existing test suite notice a naive "swap" implementation? | **No coverage today** | There are no stack/failover tests. `orchestrator-session-harness.test.ts` pins the *opposite* behavior (same-kind alias switch starts fresh). Any green suite after a naive change would be meaningless for this feature. | repo HEAD | `src/bun/orchestrator-session-harness.test.ts` |

**S1 detail that matters for the design:** `claude --resume <absolute-path>` also worked, but it wrote the updated transcript as a sibling `<sessionId>.jsonl` **in the path's directory**, not in the current `CLAUDE_CONFIG_DIR`. Passing the standard `<configDir>/projects/<encoded>/<sid>.jsonl` path made it update that file in place, which is exactly what Agetor's `jsonlPathFor` tailer expects. So the safe mechanism is: copy the transcript into the **next account's standard path** (or a task-owned canonical dir with a tailer override), then resume by id/path. Do not assume `--resume` will populate the current config dir on its own.

**S3 detail that matters:** OpenCode import is not idempotent/mergeable. Switching A → B works; switching back B → A requires deleting/exporting the stale A session first, or importing under a new id/forking. The same session id also has `opencode_watch_tombstones` implications (see §7).

---

## 3. What we're assuming

1. **A stack is same-kind.** Mixing kinds would change model ids, mode/effort semantics, session formats and often the provider; the requirement says "same harness". Cross-kind fallback (Claude → Codex) is a different feature.
2. **Each member is already logged in and configured for itself.** Agetor must never copy `.credentials.json`, `auth.json`, `cli-config.json`, the OpenCode account/credential tables or any token blob between accounts. If a member is logged out, it is skipped (or the swap fails with a clear message), not repaired by copying another account's auth.
3. **Agetor's own `run_events` log is the canonical user-visible history.** Provider-session transfer is for the *model's* context; the transcript the user sees is always Agetor's merged task stream.
4. **Exact provider-session transfer is best-effort per kind.** Where it is unavailable or unproven, a context file/summary + fresh session is acceptable *if the owner accepts the fidelity/token trade-off*. This is the biggest product question in §4.
5. **A swap happens between provider turns, not by keeping two CLIs alive on one worktree.** The old process is stopped before the new one starts; only one account may touch the worktree at a time.
6. **The task worktree path is stable** across a swap. Claude's transcript encodes `cwd`; if the worktree were recreated at a different path, a copied transcript would refer to the old path.
7. **Quota snapshots are advisory and may be stale.** Proactive selection uses the last cached `harness_usage` snapshot; the reactive post-failure path is the backstop. A missing/stale snapshot must never block a run on its own.
8. **The next account's CLI version and model catalog are compatible enough.** Same-kind accounts can still differ in CLI version, plan tier, discovered model catalog (codex/fx/opencode are per-account) and provider (fx). A model that is unavailable on the backup will fail there; the stack can skip/fail over again but cannot invent access.
9. **Copying provider state into an agent-writable home is acceptable** if done with the repo's no-follow/plain-dir/atomic-write rules and an explicit per-kind allowlist. No symlink/FIFO may be followed.
10. **The user's labels (not emails/tokens) are what the swap message shows.**
11. **The stack is a local, per-machine configuration.** It is not synced and, in the implicit model, need not travel in bundles.
12. **The user wants failover, not load balancing.** Nothing here implies spreading concurrent tasks across accounts; that is a separate feature.

What changes if an assumption is wrong:
- If cross-kind stacks are required, the whole model/mode/effort/session matrix changes; treat as a separate design.
- If credential sharing is required, stop and get a security review; copying tokens between accounts contradicts the current isolation model and may violate provider terms.
- If exact mid-turn continuation is required for all eight kinds, cursor (and likely fx/copilot/antigravity) need provider-specific spikes before planning.
- If HOME-level tools/git/ssh must be shared, the feature needs a HOME-overlay or a "same home profile" restriction — a separate, broad change.

---

## 4. What we must ask the owner

The repo can answer facts; these are product/security decisions. Each says why it matters and what the evidence shows.

### A. The stack model

1. **What is a "stack" in the UI: a named group of same-kind accounts selectable as one harness, or an implicit fallback chain attached to each account?**
   Why: it decides whether `Task`, `AgentProfile`, pipeline snapshots and the bundle need a new reference. The implicit model (one stack per account, tasks follow `Task.agent`) needs no new task/profile field and makes profiles/pipelines work automatically; the explicit model allows multiple stacks sharing an account but touches every picker and the bundle. Evidence: `Task.agent`/`AgentProfile.harness`/`PipelineStep.agentProfileId` in §1.3.
2. **Can an account belong to more than one stack, and can a task opt out of failover?**
   Why: one-stack-per-account is the low-blast-radius default; multiple stacks/per-task opt-out need a `Task.harnessStackId` (or a per-task flag) and UI. If a task cannot opt out, adding an account to a stack silently changes every existing task on that account.
3. **Is the stack same-kind only, or should it be able to fall through to a different harness kind?**
   Why: same-kind keeps model/mode/effort valid and session formats transferable; cross-kind would reset config and need a context handoff. The requirement says "same harness", so this is a confirmation, not an assumption.
4. **What is the maximum stack size and the default order?** (built-in first? creation order? user drag order?)

### B. Failover semantics

5. **What counts as "reached its limit"?**
   Options: provider quota/usage limit only; OR also 429 rate limits, 402/insufficient credits, auth failures, provider outages/529, model-not-available. 
   Why: 529/5xx are account-independent; swapping on them just burns the backup. 429 can be a per-account or per-model rate limit. Auth failures are account-specific but not "limits". The classifier must be conservative; a false swap can duplicate work. Evidence: §1.5.
6. **Should Agetor swap proactively (using the cached usage meter before starting a turn) or only reactively (after the provider fails), or both?**
   Why: only 3 of 8 kinds have live quota (claude/codex/cursor); the rest can only be reactive. Proactive data is stale (10-min poll) and model-scoped meters don't map cleanly to exact model ids. A cached snapshot must never block a run on its own.
7. **Mid-turn: if the limit hits after the agent already changed files or called tools, should Agetor abort and continue the same turn on the backup, or let the turn fail and continue on the next user message?**
   Why: exact continuation is possible for Claude/codex/opencode with a copied/replayed session + a synthetic "continue" prompt, but it can duplicate tool side effects if the provider state is partial. Background agents/pending permission cards may be lost either way. Evidence: S1–S3; `dropSession` orphans subagents (`claude-tmux.ts:10191-10208`); `drainFollowUpQueues` (`orchestrator.ts:3488-3512`).
8. **If a turn failed before the model did anything (immediate 429), is a clean retry of the original prompt on the backup acceptable?** (It avoids a synthetic continuation prompt and duplicate provider user messages.)
9. **After a swap, does the task stay on the backup until it too limits (fixed train), wrap to the first account that has reset, or return to the primary when its quota resets?**
   Why: "train" suggests forward-only; a reset-aware return is nicer but adds timers/state like `fxRecovery` (`orchestrator.ts:7011-7154`).
10. **When every member is exhausted, what happens: block with a message, wait for the earliest `resetsAtMs` and auto-retry (cap/backoff), or leave it Ready for a manual Run?**
    Why: this is the difference between a short pause and a task that looks dead; the existing fx auto-resume is the closest precedent (cap 3, persisted state, timers, events).
11. **Is exhaustion account-global or per task?** If task A hits account X's 5-hour limit, should every task on X be marked cooling down and rerouted, or only A?
    Why: quota is account-global; per-task only will let N tasks each discover the same limit. A global cooldown table is a new persisted entity and needs reset/backoff semantics. Two tasks can also swap to the same backup simultaneously.
12. **Should a manual Run/message override a cooling-down account (force), or is it refused?**

### C. Continuity fidelity

13. **What does "preserve the history conversation" mean: the exact provider session (tool calls, partial turns, plan state) or a by-Agetor transcript/summary that the new agent reads?**
    Why: S1 proves exact Claude continuation; S3 proves OpenCode move (not merge); codex resolution is proven but not context-inspected; the other five are unproven. A transcript-file fallback is universal but token-heavy and cannot preserve partial tool state. This is the single biggest scope decision.
14. **Which kinds must v1 support?**
    Options: Claude Code only (best supported, most accounts in practice); claude+codex+opencode (proven mechanisms); all eight (needs 5 more spikes and per-kind adapters). A v1 that silently degrades to a summary for cursor/fx/etc. may not meet "seamless".
15. **If exact continuation is impossible, is a visible "context handoff" file acceptable?** Where may Agetor write it (task worktree, `dataDir/task-context/…`), and may the synthetic prompt be visible to the agent/model? See questions 24–26 for the message wording.
16. **Should the swap wait for background/sub-agents to finish, or abandon them?** Evidence: `dropSession` orphans subagents; `dropOpencodeTask` interrupts children and writes tombstones; a running background shell may be doing real work.
17. **What should happen to queued follow-ups and pending permission/question cards on the old account?** (Carry them to the new run, re-stash in the backlog, or cancel?) Evidence: per-kind queues in `drainFollowUpQueues`; `cancelPendingForTask` is not called by `reconcileTaskSession` today (only by kill/archive/delete paths).

### D. Configuration, tools, MCP, skills, auth, APIs

18. **Must the backup account automatically use the primary's user-level MCP servers, skills, commands/plugins and CLI settings, or is each account expected to be configured separately?**
    Why: today user-level entries are per account (`.claude.json` `mcpServers`, `<CLAUDE_CONFIG_DIR>/skills`, `~/.cursor/mcp.json`, `<COPILOT_HOME>/mcp-config.json`, …). Project-level entries are shared. Auto-sharing needs per-kind injection/merge (Claude `--mcp-config`, `--plugin-dir`/skills copy; ACP `mcpServers` for cursor/fx; OpenCode config-only symlink; codex `-c`/config merge; etc.). This is a second large feature.
19. **If shared, which direction and precedence?** Primary → backup only? Merge both, backup-local wins? What about skills with the same name but different content? What if the primary is itself a backup at the time?
20. **What about MCP OAuth tokens and provider API keys?** The backup cannot use the primary's MCP OAuth session without copying credentials (rejected in §3.2); each account may need its own MCP login. API keys in `Harness.env` are per-member and switch automatically; process-wide provider keys (`ANTHROPIC_API_KEY`, …) currently leak into every harness (`core-spawn.ts:36-62`) — should Agetor scrub/override them per account?
21. **For kinds that override `HOME` (codex, cursor, fx, antigravity, opencode), must the backup keep the user's git/ssh/gh/npm config?**
    Why: a full `HOME` override hides `~/.gitconfig`, `~/.ssh`, `~/.config/gh`, etc. A stack moving from the built-in to such an account can no longer commit/sign/push the same way. Options: HOME overlay, restrict stacks to accounts with the same HOME profile, or document the limitation.
22. **Does "configuration" include CLI settings/permissions/hooks (`settings.json`, `config.toml`, …), or only Agetor's task config (model/mode/effort/speed/profile)?** The latter is preserved automatically by same-kind swaps; the former is per-account and may execute hooks, so sharing it is security-sensitive.
23. **Should Agetor validate a stack at creation (same kind, distinct effective home/account, logged in, installed, model offered) and where should it show incompatibilities?** A stack of two rows pointing at the same home/credentials gives no failover benefit.

### E. UX and visibility

24. **What should the in-transcript message look like: a muted status divider (the existing `StatusDivider` for `status` events) or a dedicated card/notice?** Should it include from/to labels, reason, reset time, stack position, and a "switch back"/"pin" action?
    Why: the existing `status` stream is the only persisted, CLI/TUI-visible transcript channel; a dedicated card is nicer but adds a new event/shape. `isInternalStatusSentinel` suppresses internal lines (`types.ts:239-247`); a visible swap line must not be suppressed.
25. **Should the synthetic continuation prompt be visible as a system block, or hidden?** If hidden, how should a later JSONL rebuild distinguish it from a real user message? (A `harness_swap` tag in `user-message.ts` or a run-level "synthetic prompt" flag.)
26. **Do you want a toast/OS notification when a swap happens (especially while the window is unfocused), or is the transcript message enough?** A `harness-swap` `GlobalEvent` would be the toast/native hook; the existing `run-status` failed toast must be suppressed for the old run.
27. **Should the task card / run panel / topbar show the active account and stack position (e.g. "2/3 · Claude — Personal")?** Should the topbar group members into one stack chip or keep one chip per account?
28. **Should the task stay visually "running" through the swap gap (kill old, copy state, spawn new), and what short status should show meanwhile?** ("Switching to backup…", then "Continuing on backup…")
29. **CLI/TUI parity:** does `agetor harness stack`/`--stack` need to exist in v1, and should `agetor ls/show/logs`/the TUI show the active member and the swap line?

### F. Integration and rollout

30. **Should stacks be selectable in Agent profiles and Pipelines, or does a profile bind a member and the stack follows implicitly?** (Implicit is free; explicit needs profile/pipeline/bundle changes.)
31. **Do existing tasks on a member start using a newly created stack immediately, or only new tasks?** What about tasks currently running?
32. **What happens when a member is disabled, logged out, deleted, reordered, or removed from the stack while tasks are on it?** Should tasks be repointed, left alone, or blocked? `harnesses.delete` currently refuses if any task/profile uses the row (`db.ts:2219`); stack membership adds another reference.
33. **Is a stack per-machine only, or must it travel in bundles/exports?** Bundles currently carry only harness refs, never accounts (`src/shared/bundle.ts:60-80`). If profiles can reference a stack, the bundle needs a stack ref and an import fallback.
34. **What is the rollout gate?** A preference/feature flag? On by default? A new Settings section? Which kinds ship first? Max stack size?

### G. Naming

35. **"Stack", "train", "chain", or "harness group"?** The repo already uses "agent" for a profile and "harness" for the account/CLI; the least confusing term in UI is probably **"Harness stack"** with **"accounts"** as members. Confirm before the plan/write-up uses it everywhere.

---

## 5. Completeness inventory

### 5.1 Callers / resolution points (direct and indirect)

- Harness resolution: `resolveHarness` (`orchestrator.ts:90-99`), `harnesses.getByIdOrKind` (32 non-test call sites; `server.ts` ×19, `pipeline-runner.ts` ×2, `orchestrator.ts` ×2, `db.ts` ×2, `bundle.ts` ×2, `src/shared/bundle.ts` ×1, `mainview/lib/api.ts` ×1, `PromptComposer.tsx` ×1, `usage/poller.ts` ×1, `opencode-session-import.ts` ×1).
- Task harness id: `taskHarnessId` (`orchestrator.ts:6127-6134`), `lastSessionIdForTask` (`:6160`), `resolveHarness` calls throughout `startTaskInner`, `sendInput`, each per-kind `send*Turn`/`spawn*` function, `reconcileTaskSession`, `attachDoneHandler`.
- Session id reads: `findLastSessionIdForHarness` (`orchestrator.ts:6146`), `runs.sessionIdsForTask` (`db.ts:3756`), `SESSION_ID_COLUMNS` (`db.ts:2917`), per-kind `findLast*SessionId` equivalents inside each send path, `sessionIdPatchFor` (`orchestrator.ts:3064`).
- Agent-switch path: `PATCH /tasks/:id` (`server.ts:5657-5700`), `reconcileTaskSession` (`orchestrator.ts:3631`), `RunPanel` `AgentSelect` (`RunPanel.tsx:8261`), CLI `agetor edit --agent`.
- Start/follow-up: `POST /tasks/:id/start` → `startTask`/`startTaskInner` (`orchestrator.ts:2009`); `POST /runs/:id/input` → `sendInput` (`orchestrator.ts:4494`); pipeline `launchStep` → `createStepTask` (`pipeline-runner.ts:1255-1400`).
- Settle: `attachDoneHandler` (`orchestrator.ts:3307`), `drainFollowUpQueues` (`:3488`), `noteFxRunSettled` (`:7011`), `recordFxPause` (`:7066`), `fireFxAutoResume` (`:7155`).
- Teardown: `dropSession` (`claude-tmux.ts:10191`), `dropCodexSession`/`dropCursorSession`/`dropGeminiSession`/`dropAntigravitySession`/`dropFxSession`/`dropCopilotSession` (orchestrator), `dropOpencodeTask` (`orchestrator.ts:6015`), `orphanRunningSubagents`, `cancelPendingForTask`.
- Usage: `pollAllUsage` (`poller.ts:172`), `refreshOne` (`:102`), `GET /usage` (`server.ts:4247`), `POST /harnesses/:id/usage/refresh` (`server.ts:5185`), `harness_usage` DB (`db.ts:2291`), topbar `App.tsx:278-280`/`:1350`.
- Status/probes: `checkHarness` (`agent-status.ts:714`), `checkAllHarnesses` (`:868`), `STATUS_CACHE_TTL_MS` (`:404-435`), `minCliVersionError` (orchestrator), `getDiscoveredModels`/`refreshHarnessModels` (`model-discovery.ts`).
- Capability discovery: `listAgentCapabilities`/`listAvailableCommands` (`commands.ts:566-700`), `discoverMcpAndPluginExtensions` (`:1102`), `userSelectors` (`:425`), `projectSelectors` (`:489`).
- Profiles/pipelines/bundle: `effectiveAgentProfile` (`orchestrator.ts:1814`), `snapshotFromProfile`, `composeLaunchPrompt` (`shared/agent-profile.ts:92`), `pipeline-runner.ts:1370`, `allLocalHarnesses` (`bun/bundle.ts:64`), `BundleHarnessRef` (`shared/bundle.ts:70`).
- UI: `NewTaskForm.tsx:933`, `TaskLaunchPickers.tsx:437-620`, `RunPanel.tsx:8261`, `SettingsDialog.tsx:675/1194/1487`, `AgentProfileDetailsDialog.tsx`, `TaskCard.tsx`.
- CLI: `harness.ts`, `add.ts:550-720`, `agent-profile.ts`, `show.ts`, `ls.ts`, `api-client.ts`.

### 5.2 Entry points new code must be wired into

- API routes + `ROUTE_POLICY` (stack CRUD/read; possibly add stacks to `/harnesses`).
- `GET /harnesses` payload (`HarnessesPayload`, `mainview/lib/api.ts:522`; `server.ts:4255`).
- `GET /tasks`/`POST /tasks`/`PATCH /tasks/:id` (agent validation; stack field if explicit).
- `POST /tasks/:id/start` / `POST /runs/:id/input` (pre-flight member selection).
- `attachDoneHandler` (post-failure swap) — the main runtime seam.
- `reconcileTaskSession` (manual same-stack member switch; decide preserve vs kill).
- Pipeline runner step creation/launch (`pipeline-runner.ts:1255-1400`).
- Agent profile create/edit/import (`server.ts:1173-1224`, `bundle.ts`).
- Settings UI section/subpage (`settings-dialog-view.ts`), New Task form, launch dialogs, RunPanel.
- CLI `agetor harness`/`add`/`edit`/`profile`/`ls`/`show` and `api-client.ts`.
- Boot reconcile (`reconcileOrphans` in orchestrator; `index.ts`/`headless.ts` boot) if a swap can be in flight.
- Usage poller/health state (cooldown) and topbar.
- Tests: `test-harness-state.ts`, `e2e/fixtures.ts`, `migrate.test.ts` pin, `route-policy.test.ts`.

### 5.3 Propagation surface

- Types: `Harness`, `HarnessStatus`, `HarnessQuota`, `HarnessTemplate`, `Task.agent`, `Run.agent`, `AgentProfile.harness`, `AgentProfileSnapshot.harness`, `PipelineStep.agentProfileId`, `BundleHarnessRef`, `GlobalEvent`, `RunEventStream`.
- DB: `harnesses`, `tasks.agent`, `runs.agent` + `runs.<kind>_session_id`, `agent_profiles.harness_id`, `tasks.agent_profile` JSON, `tasks.pipeline_run` JSON, `harness_usage`, `harness_auto_enabled`, `opencode_watch_tombstones`, `subagents`.
- Validation: harness POST/PATCH kind whitelist (`server.ts:4350-4380`), `harnesses.insert` kind whitelist (`db.ts:2160-2188`), `HarnessPatch`/`HarnessInsertInput`, env key validation, path gates.
- Contracts: `/harnesses`, `/usage`, `/harnesses/:id/usage`, `/tasks`, `/agent-profiles`, `/bundle/*`; `src/cli/api-client.ts`; `src/mainview/lib/api.ts`.
- Fixtures/seed: `e2e/fixtures.ts` harness rows/status stubs, `src/bun/test-harness-state.ts`, `agents.test.ts` harness fixtures, `orchestrator-session-harness.test.ts`, `harness-discovery.test.ts`, `harnesses.test.ts`, `migrate.test.ts`.
- Generated/derived: `HarnessStatus` cache, model catalogs per harness (`PER_HARNESS_KINDS` = fx/codex/opencode, `model-discovery.ts:48`), usage snapshots, topbar chips.

### 5.4 Existing data a migration would need

- **Implicit model:** no `tasks` backfill. Existing accounts are simply not in a stack. Existing sessions/runs are unchanged. A new `harness_stacks`/`harness_stack_members` table starts empty; a `harness_limit_state` table starts empty. No need to rebuild `harnesses`.
- **Explicit model:** add a nullable `tasks.harness_stack_id` (no backfill) and possibly `agent_profiles.harness_stack_id`; existing tasks/profiles stay null. A migration must be additive, not a `harnesses` rebuild.
- Existing `runs` already carry all per-kind session ids; a stack doesn't need a schema change there.
- Existing `harness_usage` snapshots can seed proactive decisions immediately; no backfill.
- Existing `fxRecovery` rows: a stack swap on an fx pause must decide to cancel/replace the auto-resume (`clearFxRecovery`, `cancelFxAutoResume`) rather than leave a timer aimed at the old account.

### 5.5 Docs / config / examples that describe current behavior

- `README.md:44` ("many accounts"), `:87` (extra accounts never auto-enabled), `:137-138` (Copilot second account/login caveat), `:196` (bundle portability).
- `docs/architecture/harnesses.md` (multi-account `home`, session-id scoping, auto-enable), `task-lifecycle.md` (start pre-flights, PATCH), `persistence.md` (harness tables/migrations), `security.md` (agent-writable homes/no-follow), `harness-claude-code.md` (session lifecycle/resume), `harness-codex.md`, `harness-cursor.md`, `harness-gemini.md`, `harness-fx.md`, `harness-opencode.md`, `harness-copilot.md`, `harness-antigravity.md`, `agent-profiles.md`, `pipelines.md`, `bundle.md`.
- `CLAUDE.md:99` (session ids scoped to harness), `:86-112` (rules), `:116-133` (agent kinds/env/tests).
- `docs/plans/harness-usage-tracker.md` (quota), `docs/plans/fix-fx-harness-rate-limit.md` and `docs/plans/fx-recovery-follow-ups.md` (recovery/auto-resume), `docs/plans/add-opencode-harness.md` (session import/export), `docs/plans/actionable-credential-error-panel.md` (credential error UX precedent).

### 5.6 What the change would orphan / contradict

- **`findLastSessionIdForHarness`'s "start fresh across accounts" contract** and its test (`orchestrator-session-harness.test.ts`) — stacks are a deliberate exception. Keep the non-stack behavior intact.
- Any code/test that assumes `task.agent` never changes except by a user PATCH; a swap mutates it internally.
- The "same account, fresh session" status line (`previous … context is on harness "<other>" — starting a fresh session`) will be wrong for a stack; it needs a stack-aware variant.
- `HarnessInUseError`/`harnesses.delete` if stack membership is a new reference (add a stackIds check or remove membership on delete).
- `defaultHarness` preference if it can point at a stack id (explicit model) — resolve to a member.
- Topbar layout assumptions of one chip per harness.
- Bundle import fallback if an Agent references a stack/member not on the machine.
- The "no added text" rule if a synthetic continuation prompt is introduced.

---

## 6. Runnability

- **Start locally:** `bun run dev` (desktop, `AGETOR_DATA_DIR=$HOME/.agetor-dev`, API port 4318) or `bun run dev:hmr` (Vite HMR + electrobun). `bun run wipe:dev` resets the dev data dir. The packaged app uses `~/.agetor/`.
- **Typecheck:** `bun run typecheck`.
- **Tests:** `bun test` (all Bun tests in one process; set `AGETOR_DATA_DIR` to a `mkdtemp` at the **top level** of any file importing `db.ts`/`orchestrator.ts`; restore harness rows with `snapshotHarnessState()` in `afterAll`; use `rmTestDataDir`). New test files must follow this.
- **E2E:** `bunx playwright test` (no `test:e2e` npm script). `e2e/fixtures.ts` starts a worker-scoped `E2EBackend` with fake drivers (`AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_FX_DRIVER=fake`, `AGETOR_CURSOR_DRIVER=fake`, `AGETOR_OPENCODE_DRIVER=fake`, `AGETOR_COPILOT_DRIVER=fake`, …), `AGETOR_HARNESS_AUTO_ENABLE=0`, and a temp data dir. New stack specs should seed accounts/stacks through the API or DB fixture and assert the transcript/status line/active member.
- **Real-binary seams:** the repo has an opt-in Copilot real-binary test (`src/bun/copilot-real-binary.test.ts`); the other real CLIs are exercised by unit/integration tests with stub/fake drivers. On this machine the installed binaries are claude 2.1.319, codex 0.166.0, cursor-agent 2026.10.22-27dcf5f, fx 0.0.15, opencode 2.1.3, tmux; gemini/agy/copilot are **not installed** here (so those kinds must be tested via fakes/stubs or another machine).
- **Fake-driver scenarios available for a limit test:** `AGETOR_FAKE_CLAUDE_API_ERROR=1` (emits 529; parameterize to 429), `AGETOR_FAKE_FX_RECOVERY=1` / `FAKE_FX_RECOVERY_PROMPT_MARKER`, `AGETOR_FAKE_OPENCODE_ERROR=…` / `FAKE_OPENCODE_ERROR_PROMPT_MARKER`, and the existing resolve-delay seams. A new per-kind `AGETOR_FAKE_<KIND>_LIMIT` or a generic error marker will be needed for all eight.
- **No existing stack tests.** The current `orchestrator-session-harness.test.ts` pins the opposite behavior; it must be extended, not deleted.

---

## 7. Risks & blast radius

**Product/behavioral**
- Mid-turn swap can duplicate tool side effects (a retried tool edits files twice) or lose partial work. Background agents, pending permission cards, queued follow-ups and open plan cards may be orphaned.
- A 529/5xx/network error misclassified as an account limit wastes the backup and can hide a real outage. A model-specific limit misclassified as account-wide swaps unnecessarily.
- A backup with a lower plan/model catalog can't run the task's model; the train can stall at the worst moment.
- `Task.agent` changes under a profile-bound task; the frozen profile snapshot still names the original harness, so the UI/Agent chip can disagree with the active run.
- If the stack applies implicitly to every task on a member, adding a backup changes existing tasks' failover behavior with no per-task opt-out.
- Account-global cooldown vs per-task: two tasks can hit the same account and both swap to the same backup; no concurrency coordination exists.

**Data/session**
- Copying a provider session into another account's home can copy a **credential** if the allowlist is wrong (`auth.json`, `.credentials.json`, `cli-config.json` `authInfo`, OpenCode account/credential tables, keychain-backed tokens).
- Agent-writable homes: a planted symlink/FIFO/oversized file in a session path could make the core read/copy a protected file or block/deadlock. Use no-follow/`isPlainDirBelow`/regular-file checks/atomic writes and never follow a final symlink.
- Claude: transcript can be MBs; `<sid>/tool-results` can be huge; the copy must be async/atomic and the tailer's EOF offset must be preserved. A copied transcript's `cwd` must match the task worktree.
- Codex: a fresh CODEX_HOME resolved the rollout, but a home with an existing `thread_history_1.sqlite` projection may prefer stale DB state; `codex migrate-rollouts --apply` may be needed after copy. The rollout format varies by CLI version.
- OpenCode: import is not a merge (`Session already exists`); switching back needs a delete/export/import move. Same session id + `opencode_watch_tombstones` can make the new account's session look like a dropped task's session; the watch/interrupt logic must be reviewed. `session export` excludes child sessions.
- Cursor may be server/cloud-bound; copying `~/.cursor/chats` may not make `session/load` work under another account. This is unproven and could invalidate cursor support.
- fx/gemini/copilot/antigravity session copies are unproven; their CLIs may validate provider/account/session ownership.

**Runtime**
- The Bun main thread is shared: a synchronous multi-MB copy/export blocks every task. Use async/cooperative I/O.
- A swap must preserve the "one in-flight run per task" invariant and `startingTaskIds`/`pendingCancelRunIds`; a Stop during the gap must cancel the successor.
- `attachDoneHandler` is a dense seam: column update, `run-status`, fx settlement, queue drain, subagent hold, pipeline displaced-run reporting. A swap inserted in the wrong order double-settles or bounces the card.
- Boot reconciliation: a crash between "old run failed" and "new run registered" can leave a `running` task with no live run. A persisted swap intent (like `fxRecovery`) or a boot sweep is needed.
- `drainFollowUpQueues` after a swap can start a competing turn on the new member unless the swap owns the queue first.
- Pending permission/question cards on the old session must be cancelled; `reconcileTaskSession` doesn't call `cancelPendingForTask` today, so the swap path must.

**Security/trust**
- Never copy credentials; never log tokens or account emails; labels only.
- Session/context files may contain tool output (including secrets); keep them user-only, no-follow, and clean them up on archive/delete/retention.
- Provider env vars in Agetor's process env leak into every harness (`childEnv` only scrubs `AGETOR_API_TOKEN`). A stack that relies on per-account `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` could silently use one global key for all members.
- A malicious agent can write its own harness home; if Agetor copies from that home, validate the source is a regular file below a plain dir and the source account is the one we think it is.
- Home-override kinds lose `~/.ssh`/`~/.gitconfig`/`gh` auth; a swap can turn a working git/commit task into a failing one without any provider limit.

**Compatibility/docs**
- Existing tests pin "same-kind switch starts fresh"; keep them for non-stack tasks and add a stack-specific test.
- New routes must be in `ROUTE_POLICY` or the server won't start; new migrations must be additive and not rebuild `harnesses`; test cleanup must extend `snapshotHarnessState`.
- The bundle is not a stack export; a user moving a profile to another machine gets the built-in fallback, not the stack. Document it.
- CLI/TUI parity, README, architecture docs and the `CLAUDE.md` rules all need updating in the same change.

---

## 8. Candidate approaches (for the grill/plan, not a decision)

### 8.1 Stack identity

- **A. Implicit per-account chain (lowest blast radius).** `harness_stacks(id, label, kind)` + `harness_stack_members(stack_id, harness_id, position)` with `UNIQUE(harness_id)` — an account belongs to at most one stack. A task's stack is derived from `Task.agent`; profiles/pipelines/bundles need no new field. `Task.agent` changes to the next member on swap. Adding a backup to an existing account applies to all tasks on it (unless a per-task opt-out is added). Multiple independent stacks of a kind are possible if their member sets are disjoint.
- **B. Explicit stack entity (most flexible).** A task/profile stores `harnessStackId`; `Task.agent` remains the current member. Allows multiple stacks sharing an account and per-task opt-in, but touches `Task`, `AgentProfile`, pipeline snapshots, bundle, pickers, PATCH and tests.
- **C. Task-local multi-harness selection (most ad hoc).** A task stores a list of member ids; no global stack. Simple for one-off tasks, but every task repeats config and profiles/pipelines need arrays. Probably not worth it.

Recommendation to grill: **A** if the user wants a reusable per-account train; **B** only if multiple stacks per account or per-task opt-in is required.

### 8.2 Continuity

- **Exact per-kind transfer (preferred where proven):** before spawning on the next member, copy the current member's session state into the next member's standard location (Claude transcript + sidecars; codex rollout; fx session dir; Gemini chat; Copilot session-state; Cursor chat dir if local; OpenCode export/import as a move). Record the same session id on the new run; resume with the provider's resume flag.
- **Canonical session directory (Claude-first):** keep the transcript in a task-owned dir (`dataDir/task-sessions/<taskId>/…`) and pass `--resume <absolute-path>` to every member; the tailer points at the canonical file. Avoids per-swap copies but needs a run-level transcript-path override and a fallback for kinds that only take ids.
- **Context file + fresh session (universal fallback):** render the Agetor event log to a Markdown transcript; send a synthetic prompt telling the new agent to read it and continue. Provider-agnostic, token-heavy, cannot preserve partial tool state. Best for unproven kinds or when the provider session is gone.
- **Hybrid:** exact transfer where the per-kind adapter says yes; context file otherwise, with a visible note in the transcript.

### 8.3 Limit detection

- **Proactive (cached quota):** choose the first member whose session/weekly/model-scoped meters aren't exhausted (for claude/codex/cursor), skip accounts with a live cooldown, fall back to the first available if data is stale/missing. Must never block on a stale/missing snapshot alone.
- **Reactive (per-kind sentinel/classifier):** add a shared `classifyLimitSignal(kind, text, structured?)` and, where available, a driver-level `HARNESS_LIMIT_STATUS_PREFIX` payload. Map: claude 429/402 + usage-limit notice; codex 429/usage; cursor 429/402; fx `rate_limited`/`request_limit_reached`; opencode 402/insufficient funds; copilot/gemini/antigravity message patterns. Exclude 5xx/529/network; decide auth separately.
- **Cooldown:** a `harness_limit_state(harness_id PK, reason, exhausted_until_ms, source, message, updated_at)` table (no FK, like `harness_usage`) written on reactive failures and read by proactive selection; cleared on success/expiry. Or derive only from quota and keep a short in-memory cooldown for reactive failures (weaker across restarts).

### 8.4 Capability/config sharing

- **Warn/validate only (smallest v1):** at stack creation, compare user-level MCP/skills/CLI versions/model catalogs and show missing entries; each account is configured by the user. Doesn't meet "must be preserved" if read literally.
- **Inject per kind (larger v1):** Claude `--mcp-config` (merged JSON) + a generated/copied skills/plugin dir; cursor/fx ACP `mcpServers` + skill dir copy; OpenCode share the config dir only (not the data/auth dir); codex config merge; copilot `mcp-config.json`/skills copy; gemini/antigravity selective settings/skills. All must exclude credential files.
- **HOME overlay for HOME-override kinds:** a per-account HOME that symlinks/copies standard dotfiles (`~/.gitconfig`, `~/.ssh`, `~/.config/gh`, …) but keeps the CLI's own state dirs separate. This is a separate, broad feature; without it, mixing built-in and alias accounts changes the tool environment.

---

## 9. References

- Multi-account model: `README.md:44`, `docs/architecture/harnesses.md`, `src/shared/types.ts:333-405`, `src/bun/agents.ts:427-509`.
- Session continuity: `docs/architecture/harness-claude-code.md` (session lifecycle), `harness-codex.md`, `harness-cursor.md`, `harness-gemini.md`, `harness-fx.md`, `harness-opencode.md`, `harness-copilot.md`, `harness-antigravity.md`; `orchestrator.ts:6146`; `orchestrator-session-harness.test.ts`.
- Limits/usage: `docs/plans/harness-usage-tracker.md`, `docs/plans/fix-fx-harness-rate-limit.md`, `docs/plans/fx-recovery-follow-ups.md`, `src/bun/usage/*`, `src/shared/types.ts:1141-1160`.
- Agent profiles/pipelines/bundles: `docs/architecture/agent-profiles.md`, `pipelines.md`, `bundle.md`; `src/shared/agent-profile.ts`, `src/bun/pipeline-runner.ts`, `src/shared/bundle.ts`.
- Security: `docs/architecture/security.md:62-67`, `CLAUDE.md:86-112`.
- Persistence/migrations: `docs/architecture/persistence.md`, `src/bun/migrations/index.ts` (latest 083).
- Existing recovery precedent: `docs/plans/fx-recovery-follow-ups.md`, `src/shared/types.ts:147-247`, `orchestrator.ts:7011-7154`.

---

### Bottom line for the next step

The feature is feasible, but **not as a small routing change**: the conversation and the account's user-level capabilities are deliberately isolated today. The proven path is:

1. Same-kind accounts only.
2. A stack order attached to accounts (implicit model preferred) or to tasks/profiles (explicit model).
3. Proactive quota selection + reactive limit detection.
4. Per-kind session migration for the proven kinds (Claude, Codex, OpenCode) and a context-file fallback for the rest, with a synthetic continuation prompt visible as a system notice.
5. Never copy credentials; validate every member is logged in; warn about HOME/tool/config differences.
6. Keep the task `running`, insert a new run on the next member, suppress the old run's failure toast, and append a persisted swap status line.

The grill should settle the stack model, mid-turn semantics, fidelity per kind, and the auth/capability-sharing boundary before `write-plan` starts.
