# Investigation — Add OpenCode harness

| Field | Value |
| --- | --- |
| Date | 2026-10-26 |
| Change | Add OpenCode (`opencode`, anomalyco/opencode) as a seventh agent kind (`AgentKind = "opencode"`). This brief informs the grill/plan decisions: which OpenCode major(s) to support, which driver architecture, how modes, models, effort, auth and multi-account map, and the full list of agetor surfaces a new kind touches. |
| Agents | 0 sub-agents (the pipeline step forbids spawning them). Codebase, git history, web docs and OpenCode source were all read inline. |
| Flags | Live spikes were **blocked**: the auto-mode classifier denied `npm install` of `@opencode/cli` / `opencode-ai` into the scratchpad. Every OpenCode behavior below is **verified from source only** (the v2.1.4 tarball and v1.19.4 files read from GitHub), not from a running binary. |

Slug: `add-opencode-harness`. Source copies for re-reading (untrusted data, read-only):
- v2: `<scratchpad>/src-oc2/opencode-2.1.4/` (tag `v2.1.4`)
- v1: `<scratchpad>/src-oc1/run-v1.19.4.ts`, `<scratchpad>/src-oc1/index-v1.ts` (tag `v1.19.4`)

---

## 1. What we know

### 1a. OpenCode now ships two incompatible major lines, both live

| Line | npm package | Latest | Binary | Other channels |
| --- | --- | --- | --- | --- |
| OpenCode 1 | `opencode-ai` (`latest` dist-tag) | 1.19.4 (2026-10-22); 1.19.0 (2026-10-11) added `opencode upgrade --major` | `opencode` | curl `opencode.ai/install` |
| OpenCode 2 | `@opencode/cli` | 2.1.4 (2026-10-23); 2.0.0 shipped 2026-09-11 | `opencode` and `opencode2` (npm `bin` map) | Homebrew core `opencode` = **2.1.3**; `brew install anomalyco/tap/opencode-v2`; curl `opencode.ai/v2/install` |

- The repo is `anomalyco/opencode` (default branch `dev`, ~222k stars). Its changelog now lists only 2.x, so v2 is the main line. A third-party guide says the v2 curl installer *replaces* v1, so the two can't sit side by side under one `opencode` name ([capitalandcompute guide](https://capitalandcompute.net/blog/opencode-2-0-what-changed/)). No end-of-life date for v1 was found.
- The v2 **config schema changed**: `mcp` → `mcp.servers`; `permission` → ordered `permissions`; tool names `bash`/`task`/`write`/`patch` → `shell`/`subagent`/`edit`; `agent`/`mode` → `agents`; `command`/`plugin`/`provider` became plural. v2 runs no language servers, and v1 plugins don't run on v2 (same guide). This matters for capability discovery (§4 Q9) and for tool-name mapping in the event mapper.

### 1b. The headless contract: `opencode run` (both lines)

Source anchors: v2 `packages/cli/src/commands/commands.ts` (run spec ~389–436, `ServerParams` ~15–24, `PermissionParams` ~26–36), `packages/cli/src/run/run.ts`, `packages/cli/src/run/noninteractive.ts`. v1 `packages/opencode/src/cli/cmd/run.ts` (flags 128–262).

| Flag | v1.19.4 | v2.1.4 |
| --- | --- | --- |
| `run [message..]` | ✓ | ✓ |
| `--format default\|json` | ✓ | ✓ |
| `-m/--model provider/model` | ✓ | ✓, also `provider/model#variant` |
| `--variant <effort>` | ✓ | **✗** (gone from the spec; the variant rides `-m …#variant`) |
| `--agent <name>` | ✓ | ✓ |
| `-s/--session <id>` | continue an existing id | continue, **or create the session if the id doesn't exist** (`session-target.ts` `selectSession`) |
| `-c/--continue`, `--fork`, `-f/--file`, `--title`, `--thinking` | ✓ | ✓ |
| `--auto` (plus hidden `--yolo`, `--dangerously-skip-permissions`) | ✓ | ✓ |
| `--attach`, `--dir`, `--port`, `-p/-u`, `--command`, `--share`, `--mini`, `-i` | ✓ | ✗ |
| `--standalone`, `--server <url>` | ✗ | ✓ |
| Unknown-flag handling | **`.strict()`** (`index.ts:116`) → error | effect/cli 4.0.1 — assumed strict, **unverified** (§3) |

**Prompt delivery: use stdin, never a positional argument.** Both lines join the positional message words and **wrap any word containing a space in literal double quotes** (`"${part.replace(/"/g,'\\"')}"`): v1 `run.ts:288–290`, v2 `run.ts formatMessage`. A whole prompt passed as one argv element would reach the model as `"fix the bug \"x\""`, with the quotes and escapes in the text. Both lines read stdin when it isn't a TTY (v1 `Bun.stdin.text()` at `run.ts:417`; v2 `readStdin()` in `run()`) and treat the piped text as the whole message when there's no positional message (`resolveRunInput`/`mergeInput`). So the codex-style `< promptfile` redirect is the correct delivery, and it also removes any argv-size cap (no `PROMPT_ARGV_MAX_BYTES` entry needed).

**JSON output (`--format json`) is one NDJSON object per line, `{type, timestamp, sessionID, ...data}`, and the same type names on both lines** (v2 deliberately mirrors v1):

| `type` | Payload | Notes |
| --- | --- | --- |
| `step_start` | `part {id, sessionID, messageID, type:"step-start", snapshot}` | |
| `text` | `part {id, messageID, type:"text", text, time{start,end}}` | A **whole text block**, emitted when the block ends (v1 `part.time.end`; v2 `session.text.ended`). Not token deltas, so no fx-style coalescer is needed. |
| `reasoning` | `part {…, type:"reasoning", text}` | **Only emitted with `--thinking`.** |
| `tool_use` | `part {id, tool, state:{status:"completed"\|"error", input, output\|error, title, metadata, time}}` | Emitted **once, at completion** (input and output together). The driver must synthesize the tool_use + tool_result pair from one event. |
| `step_finish` | `part {reason, cost, tokens, snapshot}` | Usage source for the run-row chip. The exact `tokens` shape in v2 is unverified; v1 is `{input, output, reasoning, cache{read,write}}`. |
| `error` | v1: `{name, data:{message}}`; v2: `{type, message}` | The mapper must read both shapes. A pre-session failure in v2 emits `sessionID:""` (`run.ts reportRunError`). |

- **There is no terminal "result" event.** The run ends when the process exits: exit `1` on error, `130` on SIGINT, else `0` (`noninteractive.ts`). The antigravity wrapper pattern (`…; echo $? > exitfile`, `src/bun/antigravity-tmux.ts:439`) is the right model, not codex's `exec` plus terminal-event pattern.
- **The session id is DISCOVERED from any line's `sessionID`** (on every event, both lines). It has a `ses` prefix (v2 `packages/schema/src/session-id.ts`). v2 would also accept an id agetor mints itself (`-s` creates when missing), but v1 would not, so discovery is the version-neutral path (codex-style `onSessionId`).
- **Non-interactive permissions.** Without `--auto`, every permission ask is **auto-rejected**. v2 replies `reject` with feedback ("This non-interactive run cannot ask the user for permission…") and the model continues. v1 replies `reject` (`run.ts:800–809`). With `--auto` they're approved `once` unless a rule explicitly denies them. Question/form tools are cancelled in v2 (the model is told to assume and continue). **No interactive approval is possible through `run`.**
- **Default permissions are permissive**: most keys `allow`; only `doom_loop`, `external_directory` and `.env` reads `ask` ([opencode.ai/docs/permissions](https://opencode.ai/docs/permissions/)). Without `--auto`, a build-agent run still edits and runs shell freely; only those three ask-classes get rejected.
- Non-JSON lines can reach stdout in JSON mode: v2 calls `UI.println("permission requested: … auto-rejecting")` regardless of format (`noninteractive.ts replyPermission`), and the wrapper merges stderr (`2>&1`). The mapper must skip lines that don't parse.

### 1c. v2 runs against a server, and by default that's a shared background daemon

- `ServerConnection.resolve` (`packages/cli/src/services/server-connection.ts`): `--server URL` → that server. `--standalone`, or `service.json disabled:true` → `Standalone.start()`. **Otherwise it ensures a long-lived background service** (port 0xC0DE = 49374, registered at `~/.local/state/opencode/service.json`) that the TUI, desktop and web apps share.
- `Standalone.start` (`services/standalone.ts`) spawns `opencode serve --stdio --port 0` as a **child that treats EOF on its stdin pipe as the end of its lease**: "The OS closes it even when the TUI is killed before Effect finalizers run." So with `--standalone`, a `tmux kill-session` / SIGHUP of the client also ends the server and the turn.
- In service mode, killing the client only interrupts the turn via the SIGINT handler (`session.interrupt`). A SIGHUP/SIGKILL would leave the turn **running inside the daemon**, outside agetor's control. The service-mode client also forwards its whole environment into the session (`Env.session()`).
- **No env var selects standalone.** The v2 env surface (`packages/cli/src/env.ts`, grep of `process.env.OPENCODE_*`) has none, so `--standalone` must be an argv flag on v2. v1 would reject it (`.strict()`). **Supporting both lines therefore needs version-gated argv**, and `AgentRunOptions` (`src/bun/agents.ts:84`) carries no CLI version today.
- `opencode acp` (v2 `commands/handlers/acp.ts`) **always uses Standalone**. It advertises `loadSession`, `session/resume`, `session/set_mode`, `requestPermission`, `promptCapabilities{image, embeddedContext}` and `sessionCapabilities{fork,list,resume,close,delete}` (`acp/service.ts:120–125`). v1 also has `opencode acp`. ACP is the alternative driver architecture (§4 Q2).

### 1d. Other OpenCode facts the plan needs

- **Agents/modes**: built-in primary agents are `build` (default, `Agent.defaultID`) and `plan`. `plan` denies `edit` except under `~/.opencode/plan/*` and injects a "You are in Plan mode" system reminder (`packages/core/src/plugin/plan.ts`). The subagents are `general` and `explore`.
- **Models** are `provider/model` ids across any configured provider. `opencode models` prints sorted `provider/model` lines (v2 `handlers/models.ts`; no `--verbose`/`--refresh` on v2, both present on v1). On v2, `opencode models` **without `--standalone` starts the background service too.** The catalog depends on which providers have credentials in that HOME, so it's account/config-scoped, like fx and codex (jubarte `52d77b03`: such kinds must be probed per harness with `harnessEnv`/`resolveBin`).
- **Effort = "variant"** (provider-specific reasoning level: `high`, `max`, `minimal`, …): v1 `--variant`, v2 `-m provider/model#variant`.
- **Auth**: v2 `opencode auth list [--format json]` → integrations with connections, or the text `No authenticated integrations` (`handlers/auth/list.ts`). Credentials can also come from env vars (shown as type `environment`). OpenCode Zen (`opencode/…`) is a login-plus-billing provider; a third-party guide says first installs get some free Zen models ([OpenCode School](https://opencode.school/lessons/models/)), but no official list of free model ids was found. **This machine has no OpenCode install and no `~/.local/share/opencode`, so it holds no credentials.**
- **State dirs** are XDG-based (`packages/util/src/global.ts` `roots("opencode")`): data `~/.local/share/opencode` (DB `opencode.db`, `OPENCODE_DB` overrides), config `~/.config/opencode` (`OPENCODE_CONFIG_DIR` overrides), state `~/.local/state/opencode`, cache `~/.cache/opencode`. A plain `HOME` override isolates all of them, unless the user exports `XDG_*_HOME`, which would win.
- OpenCode reads `.claude/` by default (prompt `~/.claude/CLAUDE.md` and `.claude/skills`; opt-outs `OPENCODE_DISABLE_CLAUDE_CODE*`) and `.agents/skills`. It also has an auto-update check (`OPENCODE_DISABLE_AUTOUPDATE`) ([CLI docs](https://opencode.ai/docs/cli/)).
- **Icon**: `@lobehub/icons@5.16.0` (locked in `bun.lock:181`) exports `OpenCode` as Mono only, with no `.Color` variant (same as Cursor/Vercel; see `src/mainview/components/kanban/AgentIcon.tsx:11–21`).

### 1e. agetor: how a kind is wired today (Antigravity, `a72534f`, plus the fix `80c015f`, is the latest template)

- The Antigravity commit touched **19 files / +1229 lines**, including `orchestrator.ts` (+211). The follow-up `80c015f` fixed two misses: tmux launch failures weren't surfaced, and the per-kind turn queue wasn't cleared on delete (`orchestrator.ts:7173`). Gemini (`94b1f2d`) touched 62 files.
- **`CLAUDE.md:102` is wrong**: it says adding a kind is "union + `AGENT_OPTIONS` + `buildCommand`/`spawnAgent`; the orchestrator and UI pick it up automatically." In practice ~12 non-type-checked sites must be edited by hand (§5).
- One-shot tmux drivers already exist for codex (`exec … < promptfile`, `src/bun/codex-tmux.ts:479`), cursor, gemini and antigravity (`"$@" "$(cat promptfile)" > log 2>&1; echo $? > exitfile`, `antigravity-tmux.ts:439`). The orchestrator pattern per one-shot kind is a turn queue (`antigravityTurnQueue`, `sendAntigravityTurn`, `spawnAntigravityTurnNow`, `drainAntigravityQueue`, `findLastAntigravitySessionId`; `orchestrator.ts:4448–4598`), a runs session-id column (`runs.antigravity_session_id`, migration 061), and boot reattach while a turn is in flight (`orchestrator.ts:820–898`).
- Known gotcha (jubarte `e100e031`): `findLast*SessionId` ignores the harness id, so a same-kind harness switch resumes the old account's session. A new `findLastOpencodeSessionId` would inherit this unless the plan fixes it.
- Harness-table rebuild migrations must stay **order-independent**: their CHECK must list every kind any branch might seed (`046_fx_harness.sql` header). The current schema has **`profile_mcp_servers`** (migration 073), which the 061 copy recipe predates, so a new rebuild must copy that column explicitly.
- Per-harness model discovery is hard-coded to `fx`/`codex` (`src/bun/model-discovery.ts:62,96,172`). `CATALOG_SCOPED_KINDS = {"fx"}` (`src/shared/types.ts:2583`).

## 2. What we proved

No live spikes ran (blocked, see the header). Each verdict below is **static, from source**. The column says what a live run must still confirm.

| Question | Verdict (source) | Evidence | Versions | Live check still needed |
| --- | --- | --- | --- | --- |
| Can the prompt go in as one argv element? | **No**: it gets wrapped in literal quotes | v1 `run.ts:288–290`; v2 `run.ts formatMessage` | 1.19.4, 2.1.4 | Confirm with a 2-word prompt |
| Does stdin delivery work? | **Yes**, when stdin isn't a TTY | v1 `run.ts:417`; v2 `run()` + `mergeInput` | both | `opencode run --format json < file` inside tmux |
| Is the JSON event schema the same on both lines? | **Yes** for type names and part shapes; `error` payload differs | v1 `run.ts:714–779`; v2 `noninteractive.ts emit(...)` | both | Capture fixtures from each line |
| Can one argv serve both lines? | **No** if v2 needs `--standalone` (v1 `.strict()` rejects it); effort flag differs too | v1 `index.ts:116`; v2 `commands.ts ServerParams` | both | `opencode run --standalone …` on v1 → error text |
| Does `--standalone` tie the turn's lifetime to the client process? | **Yes**: stdin-EOF lease | `services/standalone.ts` | 2.1.4 | `tmux kill-session` mid-turn → no surviving `opencode serve` |
| Is the session id discoverable from output? | **Yes**: `sessionID` on every line | both emitters | both | — |
| Is interactive approval possible in `run`? | **No**: auto-reject, or `--auto` approve-once | `noninteractive.ts replyPermission`; v1 `run.ts:800–809` | both | — |
| Would the existing tests notice a missing kind site? | **Partly**: the `Record<AgentKind,…>` tables fail `tsc`; the ~12 hard-coded lists (§5) don't | reading `db.ts:1809–1844`, `server.ts:3931`, `agent-discovery.ts:981`, `SettingsDialog.tsx:145/1908`, `orchestrator.ts:820–840` | — | Typecheck couldn't run: this worktree has no `node_modules` |

## 3. What we're assuming

| Assumption | If wrong |
| --- | --- |
| v2's effect/cli rejects unknown flags such as `--variant` | If it ignores them, a v1-compatible argv might work on v2 too, but `--standalone` is still needed, so gating stays |
| `tokens` in v2 `step_finish` has v1's shape | The usage mapper needs a v2 branch; fixtures will tell |
| `opencode run` exits after the session goes idle, including after `--auto` approvals | The tailer would hang; it needs an idle/death backstop like the other drivers |
| v1 session ids resume on v2 after a `upgrade --major` (same `opencode.db`?) | Resuming after an upgrade fails, so the plan needs a "start fresh with breadcrumb" fallback (as fx does resume → load) |
| A `HOME` override isolates an additional account | If the user exports `XDG_DATA_HOME`/`XDG_CONFIG_HOME`, a HOME override won't isolate; the plan may also need to set those, or `OPENCODE_CONFIG_DIR` + `OPENCODE_DB` |
| The `--standalone` server startup cost per turn is acceptable (it boots a server and loads plugins/MCP each turn) | If it's slow, the background-service mode becomes attractive despite its lifetime problems |
| `opencode models` only lists providers with credentials | If it lists everything from models.dev, discovery stops being account-scoped and the CATALOG_SCOPED treatment changes |
| v2's `UI.println` warnings land on stdout and v1 never prints non-JSON in json mode | The mapper must skip non-JSON lines either way |

## 4. What we must ask the owner

1. **Which OpenCode major(s)?** (a) v2 only (≥ 2.0; floor via a kind-level version gate, refuse v1 with an upgrade hint `opencode upgrade --major`); (b) v1 only; (c) **both**, with argv gated on the probed `--version` (v2 adds `--standalone`, effort via `#variant`; v1 uses `--variant`). That needs a new version seam into `buildCommand`/discovery (`AgentRunOptions` has none). Evidence: v2 is the main line and the Homebrew default, while npm `opencode-ai` `latest` is still 1.19.4. *Recommendation: (c) if cheap, else (a).*
2. **Driver architecture.** (a) **tmux-hosted one-shot `opencode run --format json`**: restart-safe, mirrors codex/cursor/gemini/antigravity, but no interactive permission cards; asks are auto-rejected or `--auto`-approved. (b) **ACP (`opencode acp`)**: permission cards, a structured session API and live streaming, but no restart survival (like fx), and it means generalizing the fx-specific `fx-acp.ts` or writing a second ACP driver. *Recommendation: (a) now, ACP as a later option.*
3. **v2 server mode**: `--standalone` (private server per turn; dies with the tmux session; slower start) vs the shared background service (faster; shares the user's TUI daemon; a killed tmux session can leave the turn running in the daemon). *Recommendation: `--standalone`.*
4. **Modes.** Proposed: `auto` = `--auto` (build agent, hands-off); `plan` = `--agent plan` (read-only planning; with or without `--auto`, which affects its shell/`external_directory`/`.env` asks); `ask` ("Read-only"/"no auto-approve") = build without `--auto`, which still edits freely and only rejects the three ask-classes. Is that third mode meaningful enough to ship? `CODE_PLAN_MODE.opencode = {code:"auto", plan:"plan"}`? Does a Plan task need a plan card / approve flow (cursor-style), or just the transcript?
5. **Default model and curated list.** OpenCode is provider-agnostic (`anthropic/…`, `openai/…`, `opencode/…` Zen, `github-copilot/…`, …) and the catalog is whatever the user configured. Options: (a) a small curated cross-provider list plus per-harness discovery, with `opencode` in `CATALOG_SCOPED_KINDS` (curated ∩ discovered); (b) discovery-first with a minimal curated fallback; (c) allow "no `-m`" so OpenCode uses its own configured default (breaks the "every task carries an explicit model" rule in `types.ts:2500–2510`). Which `DEFAULT_MODEL.opencode` id?
6. **Effort**: expose OpenCode variants (which values per model? they're provider-specific and v2 has no CLI to list them), or ship with no effort like gemini/antigravity (`MODEL_EFFORT_SUPPORT.opencode` all empty) and add variants later?
7. **Enabled by default?** Antigravity seeded `enabled=1` (`061`); codex/cursor/gemini/fx ship disabled. *Recommendation: disabled (experimental).*
8. **Logged-in pre-flight**: `opencode auth list` can't prove "can't run". Env-var keys exist, and some Zen models may be free. Fail open (`loggedIn: null` always), or `false` only on `No authenticated integrations` with no provider env vars set?
9. **Capability discovery** (`/` autocomplete, Extensions picker, Skills picker in Agents): implement OpenCode's roots now (skills `~/.config/opencode/skills`, `.opencode/skills`, plus `.claude/skills`/`.agents/skills`; commands `.opencode/command(s)/*.md`; MCP from `opencode.json[c]`, with v1 `mcp` vs v2 `mcp.servers`) or leave a documented gap like gemini/antigravity (`src/bun/commands.ts:365–390`)?
10. **Multi-account isolation**: a `HOME` override (cursor/fx/antigravity style, `agents.ts:340–390`), or `HOME` plus explicit `XDG_*`/`OPENCODE_CONFIG_DIR`/`OPENCODE_DB`?
11. **Parity extras in scope?** The run-row usage chip from `step_finish` tokens/cost (reusing `FX_USAGE_STATUS_PREFIX`, as cursor does); the TODO tracker from OpenCode's `todowrite` tool; the `--thinking` stream on by default; `OPENCODE_DISABLE_AUTOUPDATE=1` (`??=`) on every launch so a turn never self-updates mid-run; and fixing `findLast*SessionId` to key on harness id (jubarte `e100e031`) for the new kind, or for all kinds.
12. **Live verification.** Spikes were blocked here. May a later step install OpenCode (scratchpad, or `brew install opencode`) and run a live smoke? Which provider credential or free Zen model should it use? This machine has none.
13. **Coordination**: a concurrent branch (`feature/add-github-copilot-harness`) is adding another `AgentKind` and will also want migration **075** plus a harnesses-table rebuild. Agree that both CHECK lists include both new kinds, and use `aliases` for renumbering. The peer agent was messaged.

## 5. Completeness inventory

**Type-checked (`Record<AgentKind,…>`; `tsc` will flag a missing key):**
- `src/shared/types.ts`: `DEFAULT_MODEL` (2511), `DEFAULT_EFFORT` (2584), `CODE_PLAN_MODE` (3099), `MODEL_EFFORT_SUPPORT` (3186), `MODEL_MODE_DENY` (3537), `AGENT_OPTIONS` (3597). Partial and optional: `MODEL_MIN_CLI_VERSION` (2638) holds a v2 floor if option 1(a) is chosen.
- `src/bun/agent-status.ts:17` `INSTALL_HINTS` (Partial: `BREW_PACKAGES` :32 → `opencode`; `upgradeHintFor` :80–86 → `opencode upgrade`).
- `src/mainview/components/kanban/AgentIcon.tsx:8` (`OpenCode` Mono).
- `src/mainview/components/settings/SettingsDialog.tsx:182` `HARNESS_HOME_COPY`.
- `src/mainview/components/kanban/NewTaskForm.tsx:307` `agentCache` initializer, plus `seed(...)` calls :369–372.
- `src/mainview/components/onboarding/OnboardingChecklist.tsx:40` `LOGIN_COMMAND` (Partial → `opencode auth login`).
- `src/shared/prompt-limits.ts:20` (Partial; **no entry** with stdin delivery).

**NOT type-checked (hand-edited lists and chains, the real risk):**
- `src/shared/types.ts:296` union. `Run.opencodeSessionId` next to `antigravitySessionId` (:3947–3951).
- `src/bun/db.ts:1809–1825` `getByIdOrKind` synthetic built-in; `:1840–1844` insert kind validator; runs row type/mapper/INSERT/UPDATE (:2571, :2666, :2710–2723).
- `src/bun/server.ts:3931–3936` `POST /harnesses` kind validator plus its error text; `:4905`, `:4940` agent-models maps.
- `src/bun/agent-discovery.ts:975–983` `Promise.allSettled` list plus parallel `kinds` array (index-aligned!); `:1131` switch; a new `discoverOpencode`/`parseOpencodeModels`, exported at :1210.
- `src/bun/model-discovery.ts:62,96,172` per-harness discovery gates (fx/codex), if OpenCode is account-scoped.
- `src/bun/agents.ts`: import (:22), `resolveBin` switch (:300–330, `opencode`, `AGETOR_OPENCODE_BIN`), `harnessEnv` (:340–390), `buildCommand` branch (after :726, `AGETOR_OPENCODE_ARGS`), `spawnAgent` dispatch plus fake driver (after :3237, `AGETOR_OPENCODE_DRIVER=fake`).
- New `src/bun/opencode-tmux.ts`: log/prompt/exit paths under `dataDir/opencode-logs/`, `mapOpencodeEvent`, tailer, death watch with `SESSION_DIED_STATUS_PREFIX`, `reattachOpencodeSession`, `dropOpencodeSession`, plus surfacing tmux launch failures (the `80c015f` lesson).
- `src/bun/orchestrator.ts`: import (:117–119); reconcile SELECT plus reattach chain (:797–898); run-row session-id defaults at every `runs.insert` (:1757, :3960, :4161, :4340, :4927, :5803, :6063, :6164); spawn session-id capture (:1799); queue drains (:2682, :2725); agent-switch teardown and queue clear (:2769–2776); `sendInput` dispatch (:3747); the queue/turn/drain/findLast block (pattern :4448–4598); archive teardown (:6826); delete queue clear plus teardown (:7173, :7198).
- `src/bun/migrations/075_opencode_harness.sql` (rebuild with CHECK widened plus `profile_mcp_servers` copied, seed row, self-heal re-seed, `runs.opencode_session_id`) plus `migrations/index.ts`.
- Webview: `src/mainview/App.tsx:246` and `TaskLaunchPickers.tsx:185` `AgentModelMap` initializers; `src/mainview/lib/api.ts:212–215` `AgentModelMap` type; `SettingsDialog.tsx:145` (home-capable kinds) and `:1908` (kind list); `NewTaskForm.tsx:989–995` per-kind hint chain; `OnboardingChecklist.tsx:172–178` per-kind hints.
- CLI: `src/cli/api-client.ts:830` doc comment; `src/cli/commands/harness.ts:64,146` (kind default/labels); `src/cli/commands/attach.ts:28–48` and `src/cli/usage.ts:117` (tmux-kind copy).
- Capability discovery (if Q9 = yes): `src/bun/commands.ts:165–180` builtins switch, `:324–390` commands/skills, `:700–760` MCP; `src/bun/ref-tree.ts:301` already includes `.opencode`.
- Tests to extend: `src/bun/harnesses.test.ts` (built-in row / alias / `getByIdOrKind`, cf. :304–334), `src/bun/migrate.test.ts` (rebuild preserves rows plus `profile_mcp_servers`), `src/bun/agents.test.ts` (argv shape incl. stdin, no prompt in argv), new `src/bun/opencode-tmux.test.ts` (mapper fixtures for v1 and v2), `src/bun/orchestrator-opencode.test.ts` (queue, resume by discovered id, delete clears queue), `src/bun/agent-status.test.ts`, `src/bun/agent-discovery.test.ts`, `src/shared/types.test.ts`.
- e2e: `e2e/fixtures.ts:350–372` (add `AGETOR_OPENCODE_DRIVER: "fake"` plus `AGETOR_OPENCODE_BIN: "/bin/echo"`) if any spec starts an OpenCode run.

**Existing data a migration must handle:** `harnesses` rows (all, via explicit-column copy); no task/profile rows reference `opencode` yet; no preferences to rewrite.

**Docs describing current behavior:** `README.md:8, 34, 44, 47, 52, 79–84 (harness table), 264, 272, 294, 310–311 (env table)`; `CLAUDE.md` "Agent command shape" (a new `opencode` bullet), the env-override list, the `AGETOR_*_DRIVER=fake` list, the Persistence migration notes, and **correct `CLAUDE.md:102`**.

**What the change would orphan:** nothing. The change is purely additive.

## 6. Runnability

- Setup: this fresh worktree has **no `node_modules`**, so run `bun install` first. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` (memory: Bun PATH in agetor worktrees).
- Start locally: `bun run dev:hmr` (webview HMR, `AGETOR_DATA_DIR=~/.agetor-dev`); never dogfood against `~/.agetor`. A headless smoke recipe that doesn't touch either dir is jubarte `1ffb2336`.
- Tests: `bun run typecheck`; `bun test` (or a single file, e.g. `bun test src/bun/opencode-tmux.test.ts`). Three tests fail on main already (memory: pre-existing failing unit tests).
- E2E: Playwright via `bun node_modules/@playwright/test/cli.js test e2e/<spec>`; one run at a time. Fake-driver seams per kind in `e2e/fixtures.ts`.
- Live OpenCode: not installed. Install with `brew install opencode` (v2.1.3) or `npm i -g @opencode/cli` (v2) / `opencode-ai` (v1). It needs a provider credential (`opencode auth login`) or a free Zen model.

## 7. Risks & blast radius

- **Migration collision** with the concurrent Copilot-harness branch (both want 075 plus a harnesses rebuild). The second to merge fails its copy if its CHECK omits the other's kind.
- **The prompt-quoting trap**: argv delivery silently corrupts every prompt containing a space. Stdin is mandatory, and a test must pin "the prompt is not in argv".
- **Daemon leak / uncontrolled turn**: omitting `--standalone` on v2 starts or uses a background service that outlives the tmux session; agetor's Stop and delete can't fully stop it.
- **Version drift**: v1 `.strict()` rejects v2 flags and v2 dropped `--variant`. An argv that isn't version-gated fails outright on one line. `opencode models` discovery needs the same gating (`--standalone` on v2).
- **Permission semantics differ from every other kind**: there's no card path, and "ask" means "silently rejected with feedback". This must be explained in the mode hints and README.
- **Account-scoped catalog**: a curated default can be unrunnable for a given user (no credential for that provider), much as fx's premium tiers are. Discovery plus CATALOG_SCOPED mitigates this.
- **`external_directory` asks**: agetor worktrees live under `~/.agetor/worktrees/` while git objects live in the source repo. Without `--auto`, any tool touching the repo's `.git` or an `@`-referenced path outside the worktree is rejected.
- **OpenCode reads `.claude/` and `.agents/`** instructions and skills by default, so an agetor worktree's `CLAUDE.md`/`.claude/CLAUDE.md` (incl. the `ask_user` MCP instruction) becomes part of OpenCode's context. That's harmless (it falls back to plain text), but worth knowing.
- **Same-kind harness switch resumes the old account's session** (`findLast*SessionId`, jubarte `e100e031`). The new kind inherits this unless fixed.
- **CLAUDE.md:102's "picks it up automatically" claim** leads implementers to miss the ~12 hand-edited sites; the Antigravity follow-up `80c015f` is the evidence.
