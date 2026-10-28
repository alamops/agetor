# Grill — Add OpenCode harness

| Field | Value |
| --- | --- |
| Date | 2026-10-26 |
| Source | Pipeline "Alamo Pipeline (No Video)" step 2; `docs/plans/add-opencode-harness-investigation.md` (step 1). Further source reads of OpenCode v2.1.4 in the step-1 scratchpad (cited below as `oc2:`). |
| Mode | Interactive, answered by the owner (AskUserQuestion, six passes) |
| Flags | none |

The owner went against the recommendation five times: (1) the v2 server mode is a **per-task option** and defaults to **Shared**; (2) **every built-in harness auto-enables when its CLI is installed**, codex/cursor/gemini/fx included; (3) the session-resume harness-id fix applies to **all kinds**; (4) subagent tabs, session titles and importing outside sessions are **in this change**; (5) all 16 low-stakes defaults were accepted as listed.

## Facts established during the grill (OpenCode v2.1.4 source, not run)

- `opencode run` emits only the main session's events: `oc2: packages/cli/src/run/noninteractive.ts:236` skips any event whose `sessionID` isn't the run's own. A subagent's transcript never reaches agetor's NDJSON log.
- The v2 `subagent` tool returns the child `sessionID` in its result. It can run the child in the background ("The subagent is working in the background (sessionID: …)"), and the child's completion is injected into the parent later (`oc2: packages/core/src/tool/plugin/subagent.ts:19–58`, `session/subagent-completion.ts:39–43`).
- `opencode models` prints `provider/model` ids only (`oc2: commands/handlers/models.ts`). Variants (effort) are computed per model inside OpenCode (`oc2: packages/core/src/variant.ts`, values like `none`/`low`/`medium`/`high`/`max`/`thinking`). The CLI can't list them, only the server API (`client.model.list`) can.
- `run` refuses a variant without a model: "Cannot select a variant before selecting a model" (`oc2: run/run.ts:118–119`).
- OpenCode's Plan agent denies `edit` except under `~/.opencode/plan/*` but does **not** restrict shell (`oc2: packages/core/src/plugin/plan.ts`). Plan is read-only by instruction, not enforced for shell.
- `opencode session list` lists **top-level sessions of the cwd's project only** (`parentID: null`, `project: location.project.id`), JSON `{id,title,updated,created,projectId,directory}` (`oc2: commands/handlers/session/list.ts`). `opencode session export <id>` prints session JSON.
- The GPT-6.1 Terra branch already holds migrations **075/076** (commit `d98851e` on `feature/add-gpt-6-1-terra`). The Copilot harness branch has no commits yet, and its agent was disconnected when messaged.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Scope / versions | Which OpenCode majors? | **Both v1 and v2**, with flags chosen from the probed `--version`: ≥ 2 → v2 flags, < 2 → v1 flags, unreadable → v2 flags. No minimum-version refusal. Needs a new CLI-version seam into `buildCommand` and discovery (`AgentRunOptions` has none today). | owner (+ default #5) |
| 2 | Architecture | Driver | **tmux-hosted one-shot `opencode run --format json`** per turn (codex/cursor/gemini/antigravity pattern), exit code via the antigravity `echo $? > exitfile` wrapper. ACP is out (see completeness). | owner |
| 3 | Server mode | Standalone vs shared background service (v2) | **A per-task option, OpenCode tasks only, default Shared.** It appears wherever launch settings live, like Cursor's Max Mode: the New Task form, the launch dialogs (issue / resolve-conflicts / clone, via `TaskLaunchPickers`), task details (changeable between turns, applies to the next turn), Agent profiles (and so pipeline snapshots and bundles), and the CLI (`agetor add/edit/profile --opencode-server standalone\|shared`). Shared = no `--standalone`; Standalone = `--standalone`. | owner |
| 3a | Server mode | Additional-account harnesses (own home) | **Always Standalone.** The option shows locked with a note, because OpenCode's fixed service port (49374) could route an extra account's turn to the main account's server. | owner |
| 3b | Server mode | Teardown in Shared mode | Delete, Archive and agent-switch first **send Ctrl+C and wait up to ~5 s** for the turn to stop, then kill the tmux session, so a turn doesn't keep running inside the service. | owner |
| 3c | Server mode | v1 installs | The option is hidden or ignored; v1 has no shared server. | owner (default #6) |
| 4 | Models | Default model | An **"OpenCode default" sentinel row** (no `-m`; OpenCode uses its configured model). The picker shows that row plus every model `opencode models` discovers **per harness**. This is the one exception to "every task carries an explicit model" (`types.ts:2500–2510`). The sentinel must survive `CATALOG_SCOPED_KINDS` filtering (curated ∩ discovered). | owner |
| 5 | Effort | Variants | **Discover per model** through OpenCode's local server API (`opencode serve`, `client.model.list`), with codex's `app-server` discovery as the precedent. The picker shows "Model default" (`DEFAULT_EFFORT.opencode` = an fx-style `auto`) plus that model's real variants. It's hidden for "OpenCode default" and for models without variants; if discovery fails, only "Model default" is offered. v2 sends effort as `-m provider/model#variant`, v1 as `--variant`. | owner |
| 6 | Modes | Permission modes | **Auto + Plan.** Auto = build agent + `--auto` (hands-off, `modes[0]`). Plan = `--agent plan` **without** `--auto`. `CODE_PLAN_MODE.opencode = {code:"auto", plan:"plan"}`. No third "no auto-approve" mode. Mode hints must say that Plan still allows shell commands. | owner |
| 6a | Modes | Plan-approval card | **None.** Plan shows the transcript; the user flips Code/Plan to Auto to implement. | owner (default #8) |
| 7 | Discovery | Skills/commands/MCP | **Implement now**: skills from `~/.config/opencode/skills` and `.opencode/skills` (plus `.claude/skills` and `.agents/skills`, which OpenCode also reads); commands from `.opencode/command(s)/*.md`; MCP from `opencode.json[c]` (`mcp` on v1, `mcp.servers` on v2). Branch-scoped through `ProjectTree` like the other kinds. | owner |
| 8 | Enablement (all kinds) | Seed OpenCode enabled? | **New cross-kind rule:** built-in **codex, cursor, gemini, fx and opencode** harnesses turn **on once** the first time agetor's status check finds the CLI installed. Agetor records that it did so, and a later manual Off in Settings sticks. A CLI that isn't installed stays off and out of the pickers. Uninstalling never turns a harness off. claude-code and antigravity are already on. This reverses migration `016`'s codex posture and the codex/cursor/gemini/fx `enabled=0` seeds. | owner |
| 8a | Enablement | Existing databases | **Apply once to existing users, with a one-time toast** ("Turned on Codex, Cursor… because they're installed — turn them off in Settings"). Agetor can't tell a deliberate Off from an untouched row, so the first pass may re-enable a harness someone turned off on purpose; their next Off sticks. | owner |
| 9 | Auth | Logged-in pre-flight | **Fail open** (`loggedIn: null`, never blocks). Settings, Onboarding and `agetor harness ls` show a **non-blocking hint** ("no OpenCode credentials found — run `opencode auth login`") when `auth list` is empty. A failed turn shows OpenCode's own error. | owner |
| 10 | Parity | Extras | **All in:** the usage chip from `step_finish` tokens/cost (fx/cursor usage sentinel); `todowrite` → TODO tracker + board badge; `--thinking` always on; `OPENCODE_DISABLE_AUTOUPDATE=1` (`??=`, a harness env map can override it). | owner |
| 11 | Resume (all kinds) | `findLast*SessionId` ignores harness id (jubarte `e100e031`) | **Fix for all one-shot kinds in this change** (codex, cursor, gemini, antigravity, fx, plus opencode from the start): resume only a session the same harness created. | owner |
| 12 | Subagents | OpenCode subagent tabs | **In.** **Fill on completion**: when the `subagent`/`task` tool result names a child session, agetor creates a background-agent tab with a running badge and fills it from `opencode session export <child>` once the child finishes. Background subagents are refreshed again at turn end. No live progress inside the tab, and OpenCode's DB is never read. | owner |
| 13 | Titles | OpenCode session title | **In.** Pass `--title <task title>` on the turn that creates the session only; renaming a task doesn't rename the session. | owner |
| 14 | Import | Importing outside sessions: which ones | **In.** List sessions by running `opencode session list --format json` in **each project registered in agetor**, for each OpenCode harness/account. A session in a folder agetor doesn't know isn't listed. | owner |
| 14a | Import | Import rules | **The same rules as the Claude Code import:** in place (`isolation: "none"`), lands in Review, full transcript from `session export` persisted on a seed run, continued with `-s <id>` on the next message. A session OpenCode reports busy is refused. Same dialog with a harness column, `agetor sessions ls/import`, launch scan + toast. | owner |
| 15 | Migrations | Numbering vs sibling branches | **Next free number at merge time** (077+ after Terra's 075/076). The harnesses CHECK rebuild lists every kind any branch seeds, **including the Copilot branch's kind id** (still to confirm; `copilot` is provisional), and copies `profile_mcp_servers`. Use `aliases` if a number changes after a dev DB applied it. Peers were messaged (the Copilot agent was disconnected, so the plan must re-check that branch). | owner |
| 16 | Acceptance | Live verification | A later step **installs both lines**: v2 with `brew install opencode`, v1 with npm into the scratchpad, pointed at through `AGETOR_OPENCODE_BIN`. It smokes against `~/.agetor-dev` with a **free OpenCode Zen model if one runs without a key**. If none does, live verification stays open. The owner explicitly authorized both installs. | owner |
| D1 | Identity | Kind id / label / icon | `opencode`, "OpenCode", `@lobehub/icons` `OpenCode` Mono | owner (default) |
| D2 | Env seams | Overrides | `AGETOR_OPENCODE_BIN`, `AGETOR_OPENCODE_ARGS`, `AGETOR_OPENCODE_DRIVER=fake` | owner (default) |
| D3 | Prompt | Delivery | Always on stdin (`< promptfile`), never argv (positional words get literal quotes). A test pins "prompt not in argv"; no `PROMPT_ARGV_MAX_BYTES` entry. | owner (default) + evidence (investigation §1b) |
| D4 | Session | Discovery / resume | The session id comes from `sessionID` on any NDJSON line, resumed with `-s <id>`. A failed resume (e.g. v1→v2 upgrade) starts a fresh session and posts a status line. | owner (default) |
| D7 | Stop | Cancel | Ctrl+C into the tmux session (the client's SIGINT → `session.interrupt`), in both server modes | owner (default) |
| D9 | Discovery | Side effects | Model and variant discovery runs per harness with `harnessEnv` and **always uses `--standalone`**, so it never starts the user's background service | owner (default) |
| D10 | Multi-account | Isolation | A harness home sets `HOME` **and** `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` under that home | owner (default) |
| D11 | Instructions | `.claude/`/`.agents/` reading | Left on; agetor doesn't set `OPENCODE_DISABLE_CLAUDE_CODE*` | owner (default) |
| D12 | Hints | Install / upgrade | Install `brew install opencode`. Upgrade `brew upgrade opencode` for a Homebrew install, else `opencode upgrade`. A v1 install also gets a "v2 available: `opencode upgrade --major`" note. | owner (default) |
| D13 | Errors | Mapper | An `error` event (both shapes: v1 `{name,data.message}`, v2 `{type,message}`) fails the turn with OpenCode's message. Non-JSON stdout lines are skipped. | owner (default) |
| D14 | Bundle | Profile server field | Bundle export/import carries the new profile server field. Additive and ignored by older agetor; format stays version 1. | owner (default) |
| D15 | Tests | Coverage | The unit tests from the investigation §5 inventory, plus v1 and v2 mapper fixtures. A fake-driver e2e spec: New Task → OpenCode → run → text/tool/thinking/TODO/usage → a follow-up resumes the same session; the server option is visible; adding an OpenCode harness in Settings. Plus coverage for the new in-scope surfaces (auto-enable toast, subagent tab from a fake child export, import dialog row). | owner (default) |
| D16 | Docs | Docs | README harness + env tables; a CLAUDE.md OpenCode bullet, env/fake-driver lists, migration notes; **correct `CLAUDE.md:102`** ("picks it up automatically" is false); document the enable-when-installed rule and the all-kinds resume fix | owner (default) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Every surface in investigation §5 (type-checked tables + the ~12 hand-edited kind lists) | In this change | Finishing the kind |
| Per-task server-mode field: tasks column, PATCH allow-list, agent-profile column, snapshot, pipeline step copy, bundle field, CLI flags, every launch surface | In this change | owner (#3) |
| Auto-enable-when-installed for codex/cursor/gemini/fx/opencode + one-time pass on existing DBs + toast | In this change | owner (#8, #8a) |
| `findLast*SessionId` harness-id fix for every existing one-shot kind | In this change | owner (#11) |
| OpenCode subagent tabs | In this change | owner (#12) |
| OpenCode session titles | In this change | owner (#13) |
| Importing OpenCode sessions started outside agetor | In this change | owner (#14, #14a) |
| OpenCode capability discovery (skills/commands/MCP, v1 + v2 config shapes) | In this change | owner (#7) |
| Effort-variant discovery through OpenCode's server API | In this change | owner (#5) |
| Usage chip, TODO tracker, `--thinking`, no-auto-update | In this change | owner (#10) |
| Live smoke on real v1 + v2 binaries | In this change (best effort: stays open if no keyless Zen model runs) | owner (#16) |
| ACP driver (`opencode acp`) / interactive permission cards | Out of scope | owner chose the tmux one-shot driver (#2); ACP is a different architecture and ticket |
| A third "no auto-approve" mode | Out of scope | owner (#6): it still edits freely, so it can't be called read-only |
| Plan-approval card for OpenCode Plan | Out of scope | owner (#6a) |
| Live-updating subagent tabs (DB reads or export polling) | Out of scope | owner (#12) chose fill-on-completion |
| Renaming an OpenCode session on task rename | Out of scope | owner (#13): no v2 CLI rename; would need the server API |
| Importing sessions from folders agetor doesn't know | Out of scope | owner (#14): `session list` is project-scoped, and DB reads were rejected |
| Speed tiers / Max Mode for OpenCode | Out of scope | evidence: OpenCode has no fast-lane flag; `supportedSpeeds` → `["off"]` |
| Existing harnesses `harnesses` rows | In this change | rebuild copies every column explicitly, `profile_mcp_servers` included |
| Orphaned code | None | the change is additive, except the reversed enabled=0 seed posture (#8) |

## Assumptions still open

| Assumption | If wrong |
| --- | --- |
| Whatever kind id the Copilot branch picks is known by the time OpenCode's migration is written | The CHECK lists drift and the second branch to merge fails its rebuild copy. The plan must check `feature/add-github-copilot-harness` (its agent was disconnected and didn't receive the message) |
| A session created in Standalone mode resumes in Shared mode and vice versa (both use the same `opencode.db`) | Switching the per-task option between turns loses context. The plan needs a "fresh session" breadcrumb or must lock the option after the first run |
| OpenCode's server API (`client.model.list`) returns per-model `variants` on **both** v1 and v2, reachable via a short-lived `opencode serve` | Effort discovery degrades to "Model default" only on that line (decision #5's fallback) |
| An unknown or unsupported variant is rejected (or ignored) predictably | A stale effort id on a task fails its turn; the mapper must surface OpenCode's error (D13) |
| v1's `task` tool result carries the child session id, and v1 has a `session export`/`export` equivalent | Subagent tabs become v2-only; record a v1 gap |
| A v2 background subagent still running when `run` exits either finishes inside the Shared service or dies with a Standalone server | Its tab could stay "running" forever. The plan needs a turn-end refresh that marks unfinished children `unknown`/`stopped` |
| `opencode session list` exists on v1 with a compatible JSON shape, and "busy" status is detectable for import refusal | Import becomes v2-only, or the busy check fails open with a warning |
| An imported session's model and agent map onto the task (`build` → Auto, `plan` → Plan; last model, else "OpenCode default") | The imported task launches with the wrong mode or model on its first follow-up |
| The one-time auto-enable toast reaches the user (webview). CLI-only users won't see it | A CLI-only user doesn't learn why a harness turned on; `agetor harness ls` shows the state anyway |
| Auto-enable detection hooks into the existing status sweep (boot + 15 s `/harnesses` poll) without extra probes | Extra CLI probes per tick; budget per the existing 60 s auth cache pattern |
| `opencode run` exits once the session goes idle, including after `--auto` approvals | The tailer hangs; the death-watch/idle backstop must cover it |
| `step_finish.tokens` in v2 has v1's shape | The usage mapper needs a v2 branch (fixtures decide) |
| A keyless free Zen model exists for the live smoke | Live verification stays open (#16) and the release notes say "source-verified" |
