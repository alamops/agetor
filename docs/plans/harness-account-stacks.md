# Plan — Harness account stacks (backup accounts, automatic failover)

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Source | Pipeline "Alamo Pipeline (OpenCode)" step 3; `docs/plans/harness-account-stacks-investigation.md` (evidence) + `docs/plans/harness-account-stacks-grill.md` (41 owner decisions) + the pipeline step text. This plan is the binding spec (grill decision 39). |
| Flags | none |
| Gates | grilled + owner decisions recorded (41 decisions, 4 rounds); this plan is the binding spec and is submitted for the Implementing step. T00 gates Codex; the security review gates the full-mirror default. |
| Status | planned |
| Branch | TBD — set when execution starts |
| Base SHA | TBD — set when execution starts |

> **What this builds.** A user can put two or more accounts of the same harness kind into one ordered **harness stack** (the first account is the primary, the rest are backups). A task whose active account hits its provider limit continues on the next account without leaving `running`, with the same conversation, tools, MCP servers, skills, commands, plugins and settings. A status divider appears between the task's messages. The train wraps after the last member and pauses after one full lap; when every account is exhausted the task blocks with a countdown and retries at the earliest reset, at most three times. Each account keeps its own login. Stacks are machine-local and opt-in: no global flag, and deleting the stack makes the feature inert.

---

## 1. Objective & success criteria

Each criterion names the production path that produces it and the test that drives that path. "Fake driver" means the in-process `AGETOR_<KIND>_DRIVER=fake` seam (`src/bun/agents.ts`), not a real provider account.

| # | Criterion | Producing path | Test |
| --- | --- | --- | --- |
| C1 | A user can create, reorder, edit and delete a same-kind account stack; an account belongs to at most one stack. | `POST/PATCH/DELETE /harness-stacks` → `harness-stacks.ts` → `harness_stacks`/`harness_stack_members`; `GET /harnesses` returns `stacks` for Settings/New Task/CLI. | `src/bun/harness-stacks.test.ts`, `src/bun/server-harness-stacks.test.ts`, `e2e/harness-stack-settings.spec.ts` |
| C2 | A task on a stack account that hits a Claude usage-limit notice or a 429/402 continues on the next account and stays `running` throughout. | `claude-tmux.ts` limit notice → `HARNESS_LIMIT_STATUS_PREFIX` → `makeChunkHandler` sets `ActiveRun.limitHit` → `attachDoneHandler` → `handleHarnessLimitSettlement` → `spawnSwapContinuation`. | `src/bun/orchestrator-harness-swap.test.ts`, `e2e/harness-stack-swap.spec.ts` |
| C3 | The conversation is preserved: after a tool call, the new run resumes the transferred provider session and the next user turn continues it; before any tool call, the original prompt is retried cleanly on a fresh session. | `runs.hasToolUse` → `harness-session-transfer.ts` copies the transcript/rollout → `harness_session_handoffs` → the new run's session id → `findLastSessionIdForHarness` → `--resume`/`exec resume`; the no-tool-call branch uses `runs.lastUserText` with no transfer. | `harness-session-transfer.test.ts`, `orchestrator-harness-swap.test.ts`, e2e |
| C4 | User-level config, MCP servers, skills, commands, plugins and settings are mirrored from the primary to the backup; each account keeps its own login; harness credential files are never copied. | `harness-mirror.ts` at stack create/update and before every swap; `NEVER_COPY` assertion. | `harness-mirror.test.ts`, security review |
| C5 | The swap notice appears in the task's message stream between the old run and the new one; the task stays running; the old run's failure toast is suppressed. | New run's first `status` event carries `harness-swap:` + `HarnessSwapNotice`; RunPanel/CLI/TUI format it; `run-status.reason = "harness-swap"` suppresses the generic failure toast. | e2e DOM assertion, `src/cli/commands/logs.test.ts`, `src/cli/tui/Dashboard.test.tsx` |
| C6 | After the last member limits, the train wraps to the head; after one full lap it pauses; all-exhausted blocks with a countdown and retries at the earliest reset, cap 3. | `harness-stack.ts` lap walk → `harness-failover.ts` state/timers → `handleHarnessLimitSettlement` → `TaskHarnessState.allExhausted`. | `harness-stack.test.ts`, `harness-failover.test.ts`, `orchestrator-harness-exhausted.test.ts` |
| C7 | A manual Run/message on a cooling account forces it; a manual switch inside the same stack preserves the conversation; a switch outside the stack resets as today. | `startTaskInner`/`sendInputInner` prepare hook → `harness-failover.prepareTaskHarness`; `reconcileTaskSession` stack-aware branch. | `orchestrator-harness-swap.test.ts`, `orchestrator-session-harness.test.ts` |
| C8 | Codex failover works on the same contract, with the HOME/`CODEX_HOME` decision the spike proves (drop HOME, or the fixed overlay). | `harnessEnv` + `harness-session-transfer.ts` codex adapter + `codex exec resume`. | `harness-session-transfer.test.ts` (Codex half), `src/bun/codex-home-spike.test.ts` (opt-in real binary) |
| C9 | CLI/TUI parity: `agetor harness stack`, stack/position in `ls`/`show`/`logs` and the TUI, and the swap notice. | `src/cli/commands/harness.ts` + `src/cli/api-client.ts` + `src/cli/tui/*`. | `harness.test.ts`, `ls.test.ts`, `show.test.ts`, `logs.test.ts`, `Dashboard.test.tsx` |
| C10 | Non-stack tasks do not regress: same-account resume, same-kind alias switch starts fresh, cross-kind reset, no queues drained into a competing turn. | `findLastSessionIdForHarness` + `reconcileTaskSession` keep the old branch when no stack is involved. | existing `orchestrator-session-harness.test.ts`, extended with a stack case |
| C11 | A core crash/restart mid-swap either completes or visibly blocks the task; a pending all-exhausted retry re-arms. | `TaskHarnessState.pendingSwap`/`allExhausted` + `reconcileHarnessFailover` on boot in `index.ts`/`headless.ts`. | `harness-failover.test.ts`, boot test |
| C12 | No credential file is ever copied; no swap notice names the product, an email or a token. | `harness-mirror.ts` `NEVER_COPY`; notice formatter uses account labels only; CLI/TUI escape. | mirror tests, notice tests |

**Non-goals (v1):** OpenCode and the other six kinds; cross-kind failthrough; multiple stacks per account; per-task opt-out; bundle export of stacks; load balancing; topbar grouping; provider-key scrubbing; auth/5xx/network swaps; cross-account concurrency reservation; Windows/Linux. These are the grill's dispositions and stay out unless a new owner decision reverses them.

---

## 2. Context & constraints

### 2.1 Sources

- **Evidence:** `docs/plans/harness-account-stacks-investigation.md` (read-only investigation, spikes S1–S5, file anchors).
- **Owner decisions:** `docs/plans/harness-account-stacks-grill.md` (41 rows) and `docs/plans/harness-account-stacks-grill/round-{1,2,3,4}/answers.json`. The round-1 "copy credential files" answer is superseded by round 2 and must not be implemented.
- **This plan is the binding spec** (grill decision 39). The investigation stays as evidence. No separate PRD.
- The pipeline step text is the original ask; it lives outside the repo, so the load-bearing requirements are restated in §1 and §3 here.

### 2.2 The current model (grounded)

- A harness is a row in `harnesses`; a built-in's id equals its `AgentKind`, an additional account is an alias row of the same kind (`src/shared/types.ts:333-405`). `home` maps to `CLAUDE_CONFIG_DIR` for claude-code, `HOME`+`CODEX_HOME` for codex, and other per-kind vars (`src/bun/agents.ts:427-509`).
- `Task.agent` stores the harness id (`src/shared/types.ts:1621-1634`); `Run.agent` stores the id the run launched under (`:4492-4500`). Legacy rows store a bare kind and resolve through the built-in.
- `startTaskInner` resolves the profile then the harness, runs the availability/login/CLI-floor pre-flights, prepares the worktree, inserts the run row and spawns (`src/bun/orchestrator.ts:2009-2600`). A disabled harness refuses new runs; an in-flight run is unaffected.
- `attachDoneHandler` is the settle seam: status/exit, column, `run-status`, fx settlement, queue drain (`src/bun/orchestrator.ts:3307-3476`). `drainFollowUpQueues` is at `:3488`.
- `reconcileTaskSession` treats **any** harness-id change as a session-killing event and drops every queued follow-up (`:3631-3690`).
- `findLastSessionIdForHarness` returns the newest session id **only across runs whose `agent` resolves to that harness** (`:6146`); `orchestrator-session-harness.test.ts` pins the "same-kind alias starts fresh" behavior. A stack is a deliberate, documented exception.
- Per-kind resume: Claude transcribes to `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sid>.jsonl` plus `<sid>/subagents`, `<sid>/tool-results`, `<sid>/mcp-tasks` (`src/bun/claude-tmux.ts:3431-3445`, `:8337`); Codex rollouts live under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl` and resume with `codex exec resume <threadId>` (`src/bun/usage/codex-usage.ts:58`, `:342-408`).
- Usage/quota is a separate `HarnessQuota` snapshot in `harness_usage`, polled every 10 min (`src/bun/db.ts:2291-2330`; `src/bun/usage/poller.ts:172-198`). Only claude-code/codex/cursor have live providers. There is no cross-kind "account exhausted" concept today.
- Claude's usage-limit auto-continue notice is deliberately not carded (`src/bun/claude-tmux.ts:6572-6586`); the turn stays in flight. There is no persisted event for it. The synthetic API-error path emits `CLAUDE_API_ERROR_STATUS_PREFIX` (`:766`, `:1489-1505`).
- Codex surfaces `turn.failed`/`error` messages only (`src/bun/codex-tmux.ts:87-108`, `:141-149`); its error vocabulary includes `usage_limit_exceeded`, `rate_limit_exceeded`, `server_overloaded`, `model_not_found` (live `strings` check on codex-cli 0.166.0).
- `PATCH /tasks/:id` refuses agent/mode/model/effort/speed/maxMode changes on a profile-bound task (`src/bun/server.ts:5657-5700`); `tasks.update` skips server-managed columns (`src/bun/db.ts:1240-1321`); `ALLOWED_PATCH_FIELDS` is at `src/bun/server.ts:605`.
- `Run.origin` already exists (`src/shared/types.ts:4558-4590`) with `"continuation" | "imported" | "auto-resume" | "agent"`; `runs.insert` already writes it (`src/bun/db.ts:3094-3104`). The swap origin is a new union member, not a migration.
- `pipeline-runner.ts` subscribes to `run-status`/`column` (`:4350-4357`); `headless-notifications.ts` maps `run-status`/`column` to OS notifications (`:193-226`); `App.tsx` handles `run-status` toasts (`:1648-1683`); `RunPanel` renders status events and the AgentSelect (`:6087`, `:8261`); `SettingsDialog` renders the Harnesses section (`:1433`); `settings-dialog-view.ts:4-154` owns the section/subview state.

### 2.3 Live facts checked for this plan (read-only, this machine)

| Fact | How checked | Consequence |
| --- | --- | --- |
| `codex exec resume <uuid>` resolves a UUID; `--all` disables cwd filtering; the help does not mention `thread_history`. | `codex exec resume --help` (codex-cli 0.166.0) | Resume by thread id is the adapter's contract; the cwd is the task worktree, which is stable. |
| `thread_history_1.sqlite` is a projection DB; `codex migrate-rollouts --apply` exists. | `strings "$(command -v codex)"` | The adapter may need `migrate-rollouts` after copying into a home that already has a DB; the spike decides. |
| Codex MCP OAuth has a `file` / `keyring` / `auto` / `ephemeral` store mode and a `mcp-oauth-locks` lock dir. | `strings` on the codex binary plus `~/.codex/mcp-oauth-locks/` | Default macOS keyring storage is shared per user; file storage under `CODEX_HOME` must be enumerated and never confused with `auth.json`. |
| Codex `auth.json` holds the harness login (`tokens.access_token`, `refresh_token`, `account_id`). | `jq 'keys' ~/.codex/auth.json` (no values printed) | `auth.json` is a `NEVER_COPY` file. |
| Claude's MCP OAuth is in the macOS keychain (`mcpOAuth` credential-store code path); `.credentials.json` is the alias's harness login. | `strings` on the claude bundle; `src/bun/usage/creds.ts:44-105` | Claude MCP OAuth is already shared across `CLAUDE_CONFIG_DIR` homes on one macOS user; the mirror copies config only and never `.credentials.json`. |
| `Bun.TOML.parse` exists; there is no TOML writer dependency. | `bun -e 'console.log(Object.keys(Bun.TOML))'`; `package.json` | The Codex `config.toml` merge is a narrow section-preserving text merge, validated by `Bun.TOML.parse` in tests. |
| Latest migration is 083 (`src/bun/migrations/index.ts:214`). | repo read | New migration is 084; if a concurrent branch takes 084, renumber with `aliases` per the house rule. |

### 2.4 Repo rules that bear on this change

| Rule | Path | How this plan honors it |
| --- | --- | --- |
| Every route needs a `ROUTE_POLICY` entry or the server throws at startup. | `CLAUDE.md:86`, `src/bun/route-policy.ts`, `route-policy.test.ts` | T07 adds both stack routes and the test; `app+cli` (the CLI must work). |
| Every spawn goes through `coreSpawn`/`coreSpawnSync`; child env is explicit and scrubbed. | `CLAUDE.md:87`, `src/bun/core-spawn.ts` | T12's `codex migrate-rollouts` uses `coreSpawn`; no raw spawn. |
| Agent-writable files are read no-follow; task-dir I/O uses `task-dir-fs`; never follow a final symlink. | `CLAUDE.md:89`, `src/bun/no-follow.ts`, `docs/architecture/security.md:62-67` | T04/T05/T12 use `openReadNoFollow`/`isPlainDirBelow`, regular-file checks, atomic writes, 0600. |
| `src/shared` has no runtime imports from either process. | `CLAUDE.md:100` | T02's modules are pure; they import only `types.ts`/other shared modules. |
| Every `run_events` query must SEARCH; the plan test fails on a new method it doesn't exercise. | `CLAUDE.md:98`, `db-run-events-plans.test.ts` | T01 adds `runs.lastUserText` and `runs.hasToolUse` with `INDEXED BY idx_run_events_run` and extends the pinned test. |
| Server-managed task columns are skipped by the generic SET clause and never bump `updated_at`; `reconcileById` compares the full JSON. | `CLAUDE.md:97`, `src/bun/db.ts:1240-1321`, `src/mainview/lib/reconcile.ts:36-68` | `tasks.harness_state` is server-managed, written only by `tasks.setHarnessState`, no `updated_at` bump; the UI still sees it because `reconcileById` compares the full object. |
| Session ids are scoped to the harness that created them. | `CLAUDE.md:99`, `docs/architecture/harnesses.md:19-21` | The stack is an explicit exception implemented through a recorded handoff table; the non-stack branch is unchanged and tested. |
| Agetor never adds its own text to a user message, and nothing in a prompt names the product. | `CLAUDE.md:92` | The continuation prompt is a documented exception, hidden-tagged, no product name; the owner approved it (grill 24). |
| The Bun main thread is shared; long work is cooperative. | `CLAUDE.md:104` | T04's copy/merge yields every ~20 ms/files budget; T05/T12 use it. |
| WKWebView connection budget; no new SSE stream. | `CLAUDE.md:105` | Stacks and limit states ride the existing `/harnesses` poll; no new stream. |
| `RunPanel` is one long-lived instance; per-task state needs a reset line; no duplicate child keys. | `CLAUDE.md:112`, `docs/architecture/run-panel.md` | T15 adds/reset the countdown/banner state and uses namespaced keys. |
| CLI/TUI free text goes through `terminal-text.ts`. | `CLAUDE.md:106` | T13 escapes labels/messages in `harness stack`, `ls`, `show`, `logs`, TUI. |
| Docs and README update in the same change. | `CLAUDE.md:5`, `README.md` | T16 owns the docs; code comments cite `docs/architecture/harness-stacks.md`, not CLAUDE.md sections (`claudemd-citations.test.ts`). |
| Migrations are additive; never edit an applied one; a `harnesses` rebuild is high risk. | `docs/architecture/harnesses.md:43-51`, `docs/architecture/persistence.md:22-31` | T01 adds only `CREATE TABLE`/`ALTER TABLE tasks ADD COLUMN`; no `harnesses` rebuild. |
| Tests that mutate harness rows snapshot and restore. | `docs/architecture/persistence.md:42-44`, `src/bun/test-harness-state.ts:17` | T01 extends `snapshotHarnessState()` to stacks/limit states. |

### 2.5 Runtime & trust shape

- One Bun core owns the SQLite DB and the localhost API at a time; the desktop app and a headless/background core hand the port over (`docs/architecture/always-on-host.md`, `boot-gate.ts`, `app-takeover.ts`). A swap must survive a core restart/handoff; persisted intent + boot reconcile is the mechanism.
- Many tasks and pipeline steps run concurrently. Each task has at most one in-flight run; a swap is a new run on the same task/worktree and must preserve that invariant.
- Agents run with the user's full shell privileges; harness homes are agent-writable. The mirror/transfer reads agent-writable files, so every read is no-follow/regular-file and every write is atomic/user-only. A planted transcript must not be copyable into another account's home unless it is the task's own session and the path validates.
- Agetor spawns with `childEnv`, which scrubs only `AGETOR_API_TOKEN` (`src/bun/core-spawn.ts:36-62`). Provider env keys in Agetor's own environment leak into every harness; v1 warns at stack creation (grill 37) and strips them from mirrored `settings.json` `env`, not from the process.
- Local-first: no cloud relay, no telemetry. Stacks are machine-local.

### 2.6 Naming

- The group is a **harness stack**; a member is an **account**; the verb is **stack**. Position 0 is the **primary**, the rest are **backups**. The UI/CLI/docs use this vocabulary consistently. "Agent" remains an agent profile; "harness" remains the account/CLI row.

---

## 3. Approach & key decisions

### 3.1 Decision record

| # | Decision | Why / evidence |
| --- | --- | --- |
| D1 | **Implicit per-account chain**: a stack is an ordered membership on accounts; a task's stack is derived from `Task.agent`; a swap changes `Task.agent`. No `Task`/`AgentProfile`/pipeline/bundle field. | Grill 1; investigation §8.1. The explicit model would touch every picker, profile, pipeline and bundle; the implicit model makes profiles/pipelines inherit automatically. |
| D2 | **Same kind only**, v1 kinds **claude-code + codex**. | Grill 2/3. Same-kind keeps model/mode/effort and session formats valid. OpenCode/Cursor/others are out. |
| D3 | **One stack per account** (`UNIQUE(harness_stack_members.harness_id)`); a task's stack is derived. | Grill 1. Multiple stacks per account would need a task/profile reference. |
| D4 | **State split:** `harness_stacks` + `harness_stack_members` + `harness_limit_state` + `harness_session_handoffs` tables; `tasks.harness_state` JSON for the per-task lap/pending swap/all-exhausted. | New tables avoid a `harnesses` rebuild. `harness_state` is read with every task poll (no join), is server-managed like `fx_recovery`, and changes rarely enough that `reconcileById`'s full-JSON comparison still updates the UI. |
| D5 | **Session handoff table** records `(task, harness, column) → session id + copied paths`; `findLastSessionIdForHarness` prefers the newest handoff over older runs. | The existing lookup filters by the run's `agent`; without a handoff, the new account would never find the copied session. Rewriting historical runs is wrong. |
| D6 | **Limit classifier is conservative:** provider quota, HTTP 429, 402/insufficient credits. Exclude auth, 5xx/529, network and model-not-available. | Grill 8. A false swap wastes the backup and can duplicate work. |
| D7 | **Cooldown is account-global** in `harness_limit_state`; cleared by a successful turn or expiry; a manual Run/message forces it. | Grill 10/13. Quota is account-global; per-task cooldown would let N tasks rediscover the same limit. |
| D8 | **One-full-lap state machine:** a member is "tried" only when a run on it ends in a limit that triggers a swap; success resets the lap; a member skipped for cooling/disabled/login/model is not tried; the walk goes forward, wraps to position 0, and stops when every member is tried or unusable. | Grill 12 + open assumption 4. The pure walk is in `src/shared/harness-stack.ts` so it is testable without a DB. |
| D9 | **Swap settlement owns the old run:** `attachDoneHandler` checks `limitHit` before the normal column/status path; the swap path marks the old run `failed` with `run-status.reason="harness-swap"` (toast suppressed), cancels pending cards, orphans background agents with a status line, keeps queued follow-ups, and starts the new run. | Investigation §1.6/§7; the settle seam is dense, so one owner prevents double-settling. |
| D10 | **Exact provider-session transfer** for claude-code/codex when the old run recorded a `tool_use`, with a hidden tagged continuation prompt. If it recorded **no** tool call, retry the original prompt cleanly on a fresh session. If the transfer fails, block with a clear message (never start fresh silently). | Grill 14/16/24; S1/S2 prove the copy + resume; the no-tool-call retry avoids a duplicate provider user message. |
| D11 | **Hidden continuation prompt** is wrapped in `<harness-stack-continuation>…</harness-stack-continuation>`; `runs.origin = "harness-swap"` marks the run; all renderers hide the exact wrapper; a later JSONL rebuild can still recognize the tag. No product name. | Grill 24; the tag is stable and searchable; `Run.origin` already exists. |
| D12 | **Mirror at stack create/update and before every swap**: primary = position 0, primary wins on conflicts, backup-only entries kept, per-kind allowlist, `mirrorMode: "full"/"safe"` (safe excludes hooks/permissions). Never copy harness credential files. | Grill 18/19/20/22; security review. |
| D13 | **Codex HOME spike first.** If `CODEX_HOME` alone isolates login/resume/config/MCP/writes, drop the codex `HOME` override. If not, build the fixed allowlist overlay (only for stack members) with symlinks. | Grill 21/22; the only unresolved technical premise. |
| D14 | **All-exhausted wait:** schedule at the earliest known reset; if none, 10 min; clamp re-arms to 24 h and re-check on fire; cap 3 run attempts; a manual Run resets the cap. | Grill 11/12; follows `FX_AUTO_RESUME_MAX = 3` (`src/shared/types.ts:2547`). |
| D15 | **Crash safety:** persist `pendingSwap` and `allExhausted.nextAttemptAt` in `tasks.harness_state`; `reconcileHarnessFailover()` on boot completes/block-clears a pending swap and re-arms retries. | Grill 33; `rearmFxAutoResumes` is the precedent (`src/bun/index.ts:443-453`). |
| D16 | **No global flag.** The feature is inert without a stack; rollback is deleting the stack. | Grill 38. |
| D17 | **CLI/TUI and webview parity in the same change.** Stacks not exported in bundles; profiles/pipelines bind accounts and inherit the stack. | Grill 34/35/36. |

### 3.2 Alternatives considered and rejected

- **Explicit stack entity** (`Task.harnessStackId`, profile/pipeline refs): rejected by the owner (grill 1); it multiplies the propagation surface and the bundle format.
- **Task-owned canonical session directory** (keep the transcript in `dataDir/task-sessions/<taskId>` and pass `--resume <path>`): rejected for v1 because Claude supports a path but Codex resolves by thread id/CODEX_HOME and the tailer/offset logic is per-kind; it would need a run-level path override in every driver. The handoff table + standard destination path is narrower and S1-verified.
- **Context-file + fresh session fallback**: rejected as the default because the owner asked for "seamless"; it is the documented failure mode (block, not silently summarize).
- **Proactive-only selection** (skip by quota before starting): rejected as the primary mechanism because only three kinds have live quota and snapshots are stale; it is used only to skip a member during an automatic walk, with a fail-open rule.
- **Copying harness credentials** (round-1 answer): rejected and superseded; each account uses its own login.
- **Global feature flag**: rejected by the owner (grill 38); an inert-without-stack design is simpler and has no flag debt.
- **Topbar grouping**: rejected (grill 28); one usage chip per account remains.
- **Per-task opt-out**: rejected (grill 4); an account outside a stack is the escape hatch.

### 3.3 What rests on evidence vs reasoning

- **Proven:** Claude transcript copy + `--resume` end-to-end (S1); Codex rollout copy + `exec resume` thread resolution (S2); OpenCode export/import (S3, out of v1). Claude transcript path/sidecars (`claude-tmux.ts`). Codex rollout path/`auth.json` (live file inspection). `Run.origin` existing. `Bun.TOML.parse`.
- **Reasoned, to be proven by T00:** Codex `CODEX_HOME`-only isolation; the stale `thread_history` behavior; the exact Codex MCP OAuth file-store location.
- **Reasoned, low risk:** the lap/backoff math; the mirror merge rules; the TOML section merge; the fake-driver transcript seam.

---

## 4. Work breakdown — implementation tasks

### 4.1 Overview

| ID | Goal | Owned files (create/edit) | Depends on | Acceptance (one line) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T00 | Codex `CODEX_HOME`/stale-`thread_history`/MCP-OAuth spike (real binary, opt-in). | `docs/plans/harness-account-stacks-codex-spike.md`, `src/bun/codex-home-spike.test.ts` | none | Verdicts recorded with commands/versions; test skips loudly without `AGETOR_REAL_CODEX=1`. | tests | n/a (research) |
| T01 | Additive migration 084 + DB accessors + `tasks.harness_state` + handoffs + `runs.lastUserText` + harness-delete cleanup + test snapshot. | `src/bun/migrations/084_harness_stacks.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/test-harness-state.ts`, `src/bun/migrate.test.ts`, `src/bun/db-harness-stacks.test.ts`, `src/bun/db-run-events-plans.test.ts` | none | 084 applies on 083; state is patch-proof; handoff lookup works; deletes cascade; snapshot restores; plan test green. | migration, data, tests | migration runner + `db.ts` import |
| T02 | Shared contract: stack/limit/swap types, prefixes, pure lap/format helpers, limit classifier, mirror allowlist metadata, continuation tag, notification kind. | `src/shared/types.ts`, `src/shared/harness-stack.ts`, `src/shared/harness-limits.ts`, `src/shared/harness-mirror.ts`, `src/shared/user-message.ts`, `src/shared/os-notification.ts`, `src/shared/*.test.ts` (new/edited) | none | Pure tests cover the lap, classifier, merge allowlist, tag, event/notification exhaustiveness. | none, tests | imported by every later task |
| T03 | Stack store, validation, effective home, login evidence, cooldown CRUD/expiry, task-resolution. | `src/bun/harness-stacks.ts`, `src/bun/harness-stacks.test.ts` | T01, T02 | CRUD/order/delete; blockers vs warnings; cooling skip; same-home/kind validation; orphaned member resolution. | data, state | T07 routes, T08/T09 runtime |
| T04 | Safe file-transfer engine + mirror: per-kind allowlist, JSON/TOML merge, directory copy, `NEVER_COPY`, env strip, safe mode, atomic/cooperative, warnings. | `src/bun/harness-file-transfer.ts`, `src/bun/harness-mirror.ts`, `src/bun/harness-mirror.test.ts`, `src/bun/harness-file-transfer.test.ts`, `docs/plans/harness-account-stacks-security-review.md` | T02, T03 (pinned) | Merge fixtures; credentials never copied; symlink/FIFO/oversize rejected; safe mode excludes hooks/permissions; TOML parses after merge; mirror failures are warnings. | trust, data | T07 create/update, T09 swap |
| T05 | Claude session-transfer adapter: transcript + sidecars, destination path, atomic 0600, handoff record, cleanup, no-session result. | `src/bun/harness-session-transfer.ts`, `src/bun/harness-session-transfer.test.ts` | T01, T02, T04 (pinned interface) | Transcript/sidecars copied to the standard path; missing source → no-session; symlink/FIFO rejected; cleanup bounded; handoff recorded. | trust, data | T09 swap |
| T06 | Limit detection: Claude notice + 429/402, Codex `turn.failed`, fake-driver limit + transcript seam. | `src/bun/claude-tmux.ts`, `src/bun/codex-tmux.ts`, `src/bun/agents.ts`, `src/bun/claude-tmux-limit.test.ts`, `src/bun/codex-limit.test.ts`, `src/bun/agents.test.ts` | T02 | Pane notice emits one structured signal and resolves; 529/400/auth/network do not; fake emits a limit and writes a test transcript. | tests, state | T09 chunk handler |
| T07 | API: stack CRUD, `/harnesses` stacks + limit states, route policy, webview/CLI clients, harness-delete `stackIds`. | `src/bun/server.ts`, `src/bun/route-policy.ts`, `src/bun/route-policy.test.ts`, `src/mainview/lib/api.ts`, `src/cli/api-client.ts`, `src/bun/server-harness-stacks.test.ts` | T03, T04 | Routes work for CLI/app; validation returns 400 with blockers; create/update returns warnings + mirror result; payloads include stacks/states. | trust, data | server boot; UI/CLI clients |
| T08 | Failover engine: cooldown signals, lap/tried, next-member plan, all-exhausted schedule/cap, timers, boot re-arm/reconcile, prepare-task-harness. | `src/bun/harness-failover.ts`, `src/bun/harness-failover.test.ts` | T03, T05 | Lap transitions, skip rules, earliest-reset wait, cap 3, re-arm, reconcile, manual reset, archived/deleted no-op. | state, concurrency | T09 orchestrator + boot |
| T09 | Orchestrator glue: `limitHit`, swap settlement/spawn, hidden continuation, task handoff, manual switch, boot wiring, delete/retention cleanup. | `src/bun/orchestrator.ts`, `src/bun/index.ts`, `src/bun/headless.ts`, `src/bun/retention.ts`, `src/bun/orchestrator-harness-swap.test.ts`, `src/bun/orchestrator-harness-exhausted.test.ts`, `src/bun/orchestrator-session-harness.test.ts` | T04, T05, T06, T08 (pinned) | Full happy path; queues/cards/subagents; stop/delete; transfer/spawn failure blocks; force; manual switch; boot; retention cleanup. | state, concurrency, data, trust | `attachDoneHandler`/`startTask`/`sendInput`/boot |
| T10 | Pipeline and notification integration: ignore swap-settled step runs; blocked/exhausted reasons; `harness-swap` OS/toast mapping. | `src/bun/pipeline-runner.ts`, `src/bun/headless-notifications.ts`, `src/bun/pipeline-harness-swap.test.ts`, `src/bun/headless-notifications.test.ts` | T09 (pinned event contract) | A step swap does not fail the step; parent reflects the retry; swap/exhausted notifications are correct and silent for the old run. | state, tests | global event subscribers |
| T11 | Codex HOME: drop `HOME` if the spike proves isolation, else the fixed overlay for stack members. | `src/bun/agents.ts`, `src/shared/types.ts` (doc), `src/bun/agents-codex-home.test.ts`, `src/bun/agents.test.ts` | T00, T06 | Correct codex env per verdict; overlay links only the allowlist; existing test updated; docs. | trust, tests | `buildCommand`/`spawnAgent`/`checkHarness` |
| T12 | Codex session-transfer adapter: rollout copy, stale-DB handling, resume, cleanup. | `src/bun/harness-session-transfer.ts`, `src/bun/harness-session-transfer.test.ts`, `src/bun/usage/codex-usage.ts` | T04, T05, T00 | Copied rollout resumes; missing rollout → no-session; stale-DB path per verdict; cleanup. | data, trust | T09 swap |
| T13 | CLI parity: `agetor harness stack`, stack/position in `harness ls`/`ls`/`show`, swap notice/hidden prompt in `logs`, TUI divider/toast. | `src/cli/commands/harness.ts`, `harness.test.ts`, `ls.ts`, `ls.test.ts`, `show.ts`, `show.test.ts`, `logs.ts`, `logs.test.ts`, `src/cli/tui/Dashboard.tsx`, `Dashboard.test.tsx`, `useGlobalEvents.ts`, `useGlobalEvents.test.ts` | T07, T09, T10 | Create/list/edit/remove; order; positions; countdown; notice; no hidden prompt; escaped text. | tests | CLI dispatch / TUI |
| T14 | Settings: Stacks section + editor (virtualized, order, mirror mode, blockers/warnings) and Harnesses row badges. | `src/mainview/components/settings/HarnessStacksSection.tsx`, `src/mainview/lib/stack-editor.ts`, `stack-editor.test.ts`, `settings-dialog-view.ts`, `settings-dialog-view.test.ts`, `SettingsDialog.tsx` | T07 | Create/edit/delete; drag order; blockers prevent save; warnings; >10; badges; delete copy. | none, tests | Settings dialog |
| T15 | Task surfaces: stack badges, active account, all-exhausted banner/countdown, swap notice, hidden continuation, App toast/OS, search/history filters. | `src/mainview/components/kanban/StackBadge.tsx`, `NewTaskForm.tsx`, `TaskLaunchPickers.tsx`, `RunPanel.tsx`, `TaskCard.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/toasts.ts`, `harness-stack-view.ts` + test, `event-search.ts` + test, `message-history.ts` + test | T07, T09, T10 | Badges; `2/3`; notice; hidden prompt; countdown; toast; no key collisions/reset. | tests | App/RunPanel/TaskCard |
| T16 | Docs/architecture/topic map/security review sign-off. | `README.md`, `CLAUDE.md`, `docs/architecture/harness-stacks.md`, `harnesses.md`, `task-lifecycle.md`, `persistence.md`, `security.md`, `harness-claude-code.md`, `harness-codex.md`, `run-panel.md`, `notifications.md`, `agent-profiles.md`, `pipelines.md`, `bundle.md`, `docs/architecture/README.md`, `docs/plans/harness-account-stacks-security-review.md` | all code | Docs match behavior; topic map; citations test; security review signed. | none | n/a |
| T17 | E2E acceptance: two-account Claude stack swap + settings. | `e2e/harness-stack-swap.spec.ts`, `e2e/harness-stack-settings.spec.ts`, `e2e/fixtures.ts`, `e2e/helpers.ts` | T06, T09, T15 | Fake limit, notice in the middle, continuation on the backup, transcript preserved, task succeeds; settings create/edit/badge. | tests | e2e backend |
| T18 | Final verification: typecheck, full `bun test`, affected e2e, plan status/claims refresh. | `docs/plans/harness-account-stacks.md` | T01–T17 | Suites green; no skips except the opt-in real-binary; plan `Status` updated. | tests | n/a |

### 4.2 Critical task details

#### T00 — Codex HOME spike (run first, opt-in)

**Question set.**
1. With the real `HOME` and only `CODEX_HOME=<account>/.codex`, does `codex --version`/`codex login status`/`codex mcp list` read and write only under `CODEX_HOME`? Does `codex exec resume <uuid>` find a copied rollout there?
2. In a `CODEX_HOME` that already contains a `thread_history_1.sqlite` from a *different* thread, does `exec resume <copied-uuid>` still resolve the copied rollout, or does the projection shadow it? If shadowed, does `codex migrate-rollouts --apply` fix it?
3. Where does Codex store MCP OAuth when `mcp_oauth_credentials_store` is `file` vs the macOS default (`keyring`/`auto`)? Is it a standalone file under `CODEX_HOME`, or rows in `state_*.sqlite`?
4. Does `codex exec` in a fresh `CODEX_HOME` with a new task-worktree cwd require a `[projects."<cwd>"]` trust entry, or does `--sandbox workspace-write` proceed without it? If it requires trust, the adapter must add **only the task worktree's** trust entry (never the primary's arbitrary `[projects.*]` entries).

**Method.** A scratchpad under `$TMPDIR`, `env -i`, temp `HOME`/`CODEX_HOME`, a synthetic rollout copied from a prior temp session (no real prompt/tool output), and no real provider turn required: S2 proved `thread.started` is emitted before the 401. For the stale-DB arm, create a `CODEX_HOME` with a `thread_history_1.sqlite` by running a harmless `codex exec` turn only if the owner has a real login and explicitly sets `AGETOR_REAL_CODEX=1`; otherwise construct the DB by running the CLI's migration on an empty home. Never print a token; delete the scratchpad.

**Output.** `docs/plans/harness-account-stacks-codex-spike.md` with commands, versions, verdicts, and one recommendation: **drop `HOME`** or **build the overlay**. `src/bun/codex-home-spike.test.ts` is the opt-in real-binary test (`AGETOR_REAL_CODEX=1`), skipped loudly otherwise.

**Gate.** T11 must not start until this verdict is recorded. If the stale-DB arm cannot be made reliable and `migrate-rollouts` does not fix it, T12 blocks the swap with a clear message and the plan escalates to the owner (see §8) rather than shipping a silently broken Codex train.

#### T01 — Migration and DB

**Migration 084** (append; if 084 is taken, renumber and keep the old id as an `aliases` entry per `migrations/index.ts`'s house rule):

```sql
CREATE TABLE harness_stacks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude-code','codex')),
  mirror_mode TEXT NOT NULL DEFAULT 'full' CHECK (mirror_mode IN ('full','safe')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE harness_stack_members (
  stack_id TEXT NOT NULL REFERENCES harness_stacks(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (stack_id, harness_id),
  UNIQUE (harness_id),
  UNIQUE (stack_id, position)
);

CREATE TABLE harness_limit_state (
  harness_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT,
  exhausted_until_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_harness_limit_state_until ON harness_limit_state(exhausted_until_ms);

CREATE TABLE harness_session_handoffs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  copied_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, harness_id, column_name)
);

ALTER TABLE tasks ADD COLUMN harness_state TEXT;
```

**DB accessors in `src/bun/db.ts`:**
- `harnessStacks`-facing rows are owned by T03; T01 adds the generic `tasks.setHarnessState(taskId, state | null)` (targeted UPDATE, no `updated_at` bump), `toTask` calls T02's `parseTaskHarnessState` (pinned same-wave interface; malformed → null), and `tasks.update` omits `harness_state` from the SET clause.
- `harnessSessionHandoffs`: `get(taskId, harnessId, column)`, `upsert`, `deleteForTask`, `deleteForHarness`, `listForTask` (for cleanup).
- `runs.newestSessionForHarness(taskId, column, harnessId): { sessionId: string; startedAt: number } | null` (used by T09's `findLastSessionIdForHarness`).
- `runs.lastUserText(runId): string | null` — `SELECT data FROM run_events INDEXED BY idx_run_events_run WHERE run_id = ? AND stream = 'user' AND subagent_id IS NULL ORDER BY id DESC LIMIT 1` (main-stream only, like `lastEventData`); add it to `db-run-events-plans.test.ts`.
- `runs.hasToolUse(runId): boolean` — `SELECT 1 FROM run_events INDEXED BY idx_run_events_run WHERE run_id = ? AND stream = 'tool_use' LIMIT 1`. This is the grill-14 "did the model do anything with side effects?" check (Claude and Codex both emit `tool_use`; a synthetic API-error line on the assistant stream does not count; a **subagent** tool_use counts too, so no `subagent_id` filter): no tool call → a clean retry of the original prompt on a fresh session; any tool call → transfer + continuation. Add it to the plan test too.
- `runs.hasRunning(taskId): boolean` — `SELECT 1 FROM runs WHERE task_id = ? AND status = 'running' LIMIT 1`; the route guard for a stack-internal manual switch (T07) uses it. A held run (row `succeeded`, background agents still running) is not "live"; that switch keeps today's drop/orphan behavior.
- `harnesses.delete`: also `DELETE FROM harness_limit_state`, `harness_session_handoffs`; memberships cascade via FK. Keep the existing task/profile guard.
- `harnessUsage.delete` already exists; no change.

**Test hygiene:** `snapshotHarnessState()` snapshots/restores `harness_stacks`, `harness_stack_members`, `harness_limit_state` (delete test-created stacks on restore, re-insert the snapshot rows, restore limit rows). The migration test's last-id pin becomes 084.

**Acceptance.** Given an 083 DB, migrate → 084 applies once and the tables/column exist. Given a task with `harness_state`, a title PATCH leaves the state byte-identical. Given a task delete, its handoffs go. Given a harness delete with no task/profile, its membership/limit/handoffs go. Given a test that creates a stack, `snapshotHarnessState()`'s restore removes it. Given `runs.lastUserText`, the plan test exercises it and the query uses the run index.

#### T02 — Shared contract

**`src/shared/types.ts` additions** (all additive):
- `HarnessStackKind = "claude-code" | "codex"`, `HarnessMirrorMode = "full" | "safe"`.
- `HarnessStackMember { harnessId; position; label; kind; enabled }`.
- `HarnessStack { id; label; kind; mirrorMode; members; createdAt; updatedAt; warnings }` and `HarnessStackWarning { code; message; harnessId? }`.
- `HarnessStackInput { label; kind; members: string[]; mirrorMode? }`.
- `HarnessLimitReason = "quota" | "rate_limit" | "insufficient_credits"`.
- `HarnessLimitSignal { reason; resetAtMs: number | null; message: string; source: "claude-pane" | "claude-api-error" | "codex-error" }`.
- `HarnessLimitState { harnessId; reason; source; message: string | null; exhaustedUntilMs; updatedAt }`.
- `HarnessSwapNotice { from; fromLabel; to; toLabel; reason; position; count; resetsAtMs; at }` (position 1-based).
- `TaskHarnessState { stackId; position: number; tried: string[]; pendingSwap: { from; to; reason; runId; startedAt; phase: "switching" | "transferring" | "spawning" } | null; allExhausted: { at; attempts; max; nextAttemptAt; earliestResetAtMs; reason: HarnessLimitReason | "no-usable-member" } | null; lastMove: { from; to; at; reason: "member-removed" | "member-disabled" | "member-unavailable" } | null }`.
- `Task.harnessState?: TaskHarnessState | null` (optional to avoid fixture churn; `toTask` always sets null when absent).
- `parseTaskHarnessState(raw: string | null): TaskHarnessState | null` — defensive parser (malformed/missing → null), used by `toTask` in T01.
- `Run.origin?: "continuation" | "imported" | "auto-resume" | "agent" | "harness-swap" | null`.
- `GlobalEvent.run-status.reason?: "harness-swap" | "harness-exhausted"`; `GlobalEvent.column.reason` union adds `"harness-exhausted" | "harness-swap-failed"`; a new `GlobalEvent { kind: "harness-swap"; taskId; runId; fromLabel; toLabel; reason; position; count; ts; pipelineParentId?; pipelineParentTitle? }`. Add `"harness-swap"` to `PIPELINE_PARENT_STAMPED_KINDS` so a step's swap toast retargets to its parent.
- `HARNESS_LIMIT_STATUS_PREFIX = "harness-limit: "`, `HARNESS_SWAP_STATUS_PREFIX = "harness-swap: "`, `HARNESS_STACK_CONTINUATION_TAG = "harness-stack-continuation"`.
- `isInternalStatusSentinel` adds `HARNESS_LIMIT_STATUS_PREFIX` (plumbing) but **not** `HARNESS_SWAP_STATUS_PREFIX` (visible).
- `HarnessesPayload` in `src/mainview/lib/api.ts` gets `stacks`/`limitStates` in T07.

**`src/shared/harness-stack.ts`** (pure, no DB):
- `stackPositionText(stack, harnessId): string | null` (`"2/3"`).
- `nextMemberAfter(order, currentId): member | null`.
- `pickNextMember({ members, currentId, tried, now, cooling, exhaustedByQuota, usable }): { kind: "next"; member } | { kind: "all-exhausted"; earliestResetAtMs } | { kind: "none-usable"; reasons; earliestResetAtMs }`.
- `formatHarnessSwapNotice(notice): string` → exactly `Switched to <toLabel> — <reasonCopy>. Continuing from the transferred conversation.` with reason copy `usage limit reached` / `rate limit` / `out of credits`; `parseHarnessSwapNotice(data)`.
- `formatStackExhausted({ nextAttemptAt, attempts, max }): string` and `formatStackUnusable(reasons)`.
- `wrapHarnessStackContinuation(text): string` (wraps any text in the exact tag), `composeHarnessStackContinuationPrompt(): string` (the transfer branch's body), `isHarnessStackContinuation(text)`, `stripHarnessStackContinuation(text)`.
- The continuation body (no product name, owner wording from grill 24):
  `<harness-stack-continuation>\nContinue the task from where it stopped. The previous account reached its usage limit; no work was lost. Do not repeat completed steps, re-read files you already changed, or ask the user to confirm. Pick up the next action.\n</harness-stack-continuation>`
- The clean-retry branch wraps the original user text in the same tag (the body is the user's words, not the continuation instruction).

**`src/shared/harness-limits.ts`**:
- `classifyHarnessLimitSignal(kind, { text?, structured? }): HarnessLimitSignal | null`.
- Claude text: `usage limit`, `rate limit`, `too many requests`, `429`, `402`, `payment required`, `credit balance`, `insufficient credit/quota`. Codex text: `usage_limit_exceeded`, `rate_limit_exceeded`, `insufficient_quota`, `429`, `too many requests`.
- Negatives (return null): `5xx`/`529`/`overloaded`, `network`/`ECONNRESET`/`timed out`, `401`/`403`/`unauthorized`/`forbidden`, `model_not_found`/`not supported`/`not available`.
- `parseClaudeResetNotice(text, now): number | null` — parse `at 8am` / `at 3:30pm` / `when it resets` conservatively; null when unsure.
- `harnessQuotaLooksExhausted(quota, now, staleMs): boolean` — only `status === "ok"`, `now - fetchedAtMs <= staleMs`, and every unscoped meter `usedPercent >= 100` with an unexpired reset; used only for an automatic walk.

**`src/shared/harness-mirror.ts`** (metadata only; the engine is T04):
- `MIRROR_SPECS: Record<"claude-code" | "codex", { copy: string[]; merge: string[]; never: string[]; envStrip: string[] }>` — an enumerated allowlist, no globs that could sweep a credential.
- Claude copy: `settings.json` (merge), `.claude.json` only the `mcpServers`/`enabledPlugins` keys (merge; the blob lives beside the config dir as `<home>/.claude.json`, or `~/.claude.json` for the built-in — `commands.ts:420-422`), `skills/`, `commands/`, `agents/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/marketplaces/`, `plugins/data/`.
- Claude never: `.credentials.json`, `.claude/` legacy credentials, `projects/` (sessions), `history.jsonl`, `file-history/`, `shell-snapshots/`, `sessions/`, `todos/`, `statsig/`, `stats-cache.json`, `daemon/`, `session-env/`, `paste-cache/`, `backups/`, `jobs/`, `plugins/cache/`, `plugins/store/`, `plugins/plugin-catalog-cache.json`, `plugins/plugin-directory-cache-v2.json`.
- Codex copy: `config.toml` (merge `[mcp_servers.*]`, `[profiles.*]`, top-level scalars), `prompts/` (custom commands, `commands.ts`'s codex user selector), `skills/` (user skills; the CLI's bundled `skills/.system/` is not copied), `plugins/` (installed plugin definitions/data, excluding caches).
- Codex never: `auth.json`, `state_*.sqlite`, `thread_history_*.sqlite`, `logs_*.sqlite`, `history.jsonl`, `sessions/`, `log/`, `tmp/`, `shell_snapshots/`, `models_cache.json`, `queue_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite`, `app-server-*`, `mcp-oauth-locks/`.
- Codex MCP OAuth: if T00 finds a standalone file store, add it as an explicit **tool-auth copy** entry (user-only/no-follow); if it is rows in a session/state DB, leave it out and emit the warning "MCP sign-in must be repeated on this account" (see §8, unratified).
- `HARNESS_AUTH_ENV_KEYS` (explicit + prefix rule): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CURSOR_API_KEY`, plus any `*_API_KEY`/`*_AUTH_TOKEN` under those vendor prefixes. **Strip only the primary's keys before merging**: if the backup's own `settings.json` `env` already defines a harness-auth key, that is the backup's own login and must be kept (the primary's value never overwrites it).
- `SAFE_MODE_EXCLUDED_KEYS = ["hooks", "permissions"]`.

**`src/shared/user-message.ts`**: `isHarnessStackContinuation`/`stripHarnessStackContinuation` (re-export or import from `harness-stack.ts` to avoid a cycle; `user-message.ts` already imports from `agent-profile.ts`/`pipeline.ts`, so importing a pure tag constant from `harness-stack.ts` is fine). `userMessageLines` returns `[]` for the exact wrapper; `parseMessageSegments` still parses a user-typed tag in ordinary prose so the e2e can assert it is not hidden.

**`src/shared/os-notification.ts`**: add `"harness-swap"` to `NOTIFICATION_KINDS`; keep it quiet (`NEEDS_YOU_KINDS` unchanged) and add it to `UNBLOCKED_REMOVAL_KINDS` if a swap should replace a blocked entry.

**Acceptance.** Pure tests cover every lap case, the classifier table, the notice formatter (exact text, no product name), the tag (only the exact wrapper), the allowlist never contains a credential path, and the notification kind exhaustive mapping.

#### T03 — Stack store, validation and cooldown

`src/bun/harness-stacks.ts` exports:
- `list(): HarnessStack[]` (left-join members; empty stacks included; `warnings` computed from cached statuses, process env and mirror mode; no fresh probes).
- `get(id)`, `getByMember(harnessId)`, `create(input, { source: "api" })`, `update(id, patch)`, `delete(id)`.
- `validateInput(input): { blockers: HarnessStackWarning[]; warnings: HarnessStackWarning[] }`:
  - blockers: unknown harness, duplicate member, mixed kinds, kind not v1, same effective home (`claudeConfigDirFor` / `codexHome` resolved + `realpath` when it exists), >1 stack membership for an account.
  - warnings: <2 members; >10 members; disabled; not installed (cached status); login evidence false; process provider key present; full mirror's hooks/permissions; a member's model catalog differs/empty.
- `effectiveHome(harness)`: `claude-code` → `harness.home ?? ~/.claude`; `codex` → `codexHome(harness)` (the `CODEX_HOME` value).
- `loginEvidence(harness): boolean | null`: built-in Claude (home null) → `null` (keychain: unknown, never block); Claude alias → `<home>/.credentials.json` exists (no-follow `lstat`) or an `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` in `harness.env` or `process.env`; Codex → `<codexHome>/auth.json` exists or `OPENAI_API_KEY`/`CODEX_API_KEY` in `harness.env` or `process.env`; `null` when the kind has no evidence rule. Only `false` is a selection skip; `null` fails open. The process-key case also raises the cross-account warning (T03/T14).
- `setLimitState(harnessId, signal)`, `getLimitState`, `listLimitStates`, `clearLimitState`, `pruneExpired(now)`, `isCooling(harnessId, now)`. `exhaustedUntilMs = signal.resetAtMs ?? now + (reason === "rate_limit" ? 60_000 : 10 * 60_000)`; a provider reset time always wins.
- `resolveForTask(task): { stack; current: string; position: number; orphaned: boolean } | null` — prefers `harnessState.stackId` when it still resolves, else `getByMember(task.agent)`; `orphaned` when the current agent is no longer a member.
- `clearTaskStateForStack(stackId)`: iterate tasks with `harness_state` and null the ones whose `stackId` matches (targeted UPDATE; no `updated_at` bump).
- `delete(id)` clears task states referencing it. Limit states are account-global and stay.

**Acceptance.** CRUD/order/delete; a second stack containing a member is blocked by `UNIQUE(harness_id)`; same-home/kind/duplicate/unknown blocked; warnings; cooldown upsert/expiry/clear; `resolveForTask` returns orphaned after a member removal; deleting a stack clears task states but not cooldowns.

#### T04 — Safe transfer + mirror engine

`src/bun/harness-file-transfer.ts`:
- `atomicWriteFile(path, data: string | Uint8Array, { mode = 0o600 }): Promise<void>` — write a sibling temp file, `fsync`, `rename`, `chmod`; refuses a symlink at the target (lstat; rename replaces it).
- `copyRegularFile(src, dest, { maxBytes }): Promise<number>` — `openReadNoFollow`/`readTextNoFollow`; regular file only; no FIFO; size cap; dest 0600; atomic.
- `copyTreeCooperative(srcDir, destDir, { maxBytes, maxEntries, skip }): Promise<{ copied; skipped }>` — `isPlainDirBelow`/`lstat` each entry, skip symlinks/FIFOs/devices, yield every ~20 ms or N files, copy into a temp dir and rename the tree, never follow a destination symlink.
- `assertSafeRelPath(rel)` — no `..`, absolute, empty; `assertNotCredentialPath(rel, spec)` — throws if the `NEVER_COPY` list matches (defense in depth; the engine should never walk those paths).
- `removeCopiedPaths(paths, { root })` — only regular files/dirs below `root`; no-follow; used by cleanup.
- `realHomePath(p)` for the overlay (T11) — resolve `~`.

`src/bun/harness-mirror.ts`:
- `mirrorStack(stack, { source: "create" | "swap" | "update", targetHarnessId? }): Promise<{ copied: string[]; warnings: string[] }>` — source = position 0; for each target (all non-primary members on create/update, only the swap target on swap), skip if target === primary.
- Claude: deep-merge `settings.json` and the selected `.claude.json` keys; copy the allowlisted dirs. Merge rules: primary scalar wins; arrays union with primary first, dedupe; objects deep-merge by key; `mcpServers` by server name (primary wins, backup-only kept); `enabledPlugins` union, primary value wins on conflict; unknown keys preserved from the backup.
- Codex: section-preserving `config.toml` merge — split on top-level `[table]` headers, primary's `[mcp_servers.*]`/`[profiles.*]`/top-level scalars replace, backup-only sections/keys are appended; validate the result with `Bun.TOML.parse`; if the merge fails, keep the backup file and return a warning (never write invalid TOML). **Never merge `[projects.*]` trust entries**: directory trust is per-account and security-sensitive; the backup must not inherit trust for arbitrary paths from the primary. `[projects.*]` entries the backup already has are kept.
- Full mode copies hooks/permissions; safe mode drops them and never rewrites an existing backup's hooks/permissions.
- `NEVER_COPY` assertion on every source path; the **primary's** `HARNESS_AUTH_ENV_KEYS` are stripped from the `settings.json` `env` merge (a backup's own key is kept), with a count in the warnings.
- Size caps: 64 MB / 5,000 entries per tree; skip with a warning, never block the swap.
- The security review doc is written here: every copied path, why it is safe, every never path, the hooks/permissions risk, the safe-mode fallback, the no-follow/atomic rules, and the Codex MCP OAuth outcome from T00.

**Acceptance.** The merge fixtures (Claude JSON, Codex TOML with quoted names/nested tables/arrays); credentials/session DBs/transcripts never copied; the primary's harness-auth env keys stripped while a backup's own key survives; safe mode; symlink/FIFO/oversize; atomic/0600; idempotence; a mirror failure returns warnings and leaves the destination readable.

#### T05 — Claude session-transfer adapter

`src/bun/harness-session-transfer.ts`:
- `interface SessionTransferAdapter { kind; transfer(args): Promise<TransferResult>; cleanup(taskId, harnessId, column): Promise<void> }`.
- `TransferResult = { ok: true; sessionId: string; copiedPaths: string[] } | { ok: false; reason: "no-session" | "unsafe-source" | "too-large" | "io"; message }`.
- Claude `transfer({ taskId, fromHarness, toHarness, column: "claude_session_id", sessionId, cwd })`:
  - Source config dir = `fromHarness.home ?? ~/.claude`; source path = `<config>/projects/<encodeProjectPath(cwd)>/<sid>.jsonl` (fall back to the legacy `<config>/.claude/projects/...` if the fresh path is missing, mirroring `jsonlPathFor`).
  - Destination config dir = `toHarness.home ?? ~/.claude`; destination path = the fresh layout; create parent dirs 0700; copy the transcript atomically 0600.
  - Copy the sidecars `<sid>/subagents/`, `<sid>/tool-results/`, `<sid>/mcp-tasks/` if present (cooperative tree copy; size caps).
  - Record the handoff (`harness_session_handoffs.upsert`) with all copied paths.
  - Refuse if source === destination, if the source is not a regular file below a plain config dir, or if the transcript is a symlink/FIFO.
- `cleanup(taskId, harnessId, column)`: read the recorded paths, validate each below the destination config dir, remove regular files/dirs only, delete the handoff row. Never remove a path that is not recorded.
- `cleanupHarnessSessionCopies(taskId)`: iterate the task's handoffs, resolve each destination harness, and run the kind's cleanup; a missing harness/kind skips the handoff (the row is deleted only when the paths are gone or the harness is gone). Used by delete/retention in T09.
- `no-session` when the transcript does not exist (the limit hit before the first assistant turn).
- `export function claudeConfigDirFor(harness)` (T03 may import it; put it here and have T03 import, or duplicate a tiny resolver in T03 to avoid a cycle. Prefer `harness-targets.ts`? Keep it in T03 and have T05 import from `harness-stacks.ts`; T03 does not import T05.)

**Acceptance.** Copy transcript + sidecars; destination path equals `jsonlPathFor`; mode 0600; missing source → `no-session`; symlink/FIFO → `unsafe-source`; cleanup bounded; a second transfer is idempotent; a large transcript yields (cooperative).

#### T06 — Limit detection and fake seams

**Claude (`claude-tmux.ts`).**
- Export `signalHarnessLimit` on the driver/session state: add a `matchUsageLimitNotice(tail)` check in `scrapeOnce` (`claude-tmux.ts:7217-7376`) **before** `pickScrapeMatch` (the notice currently only vetoes `matchUnparsableModal` at `:5711`); when the tail matches `MODAL_NOTICE_RE` (`:6572-6586`) or `classifyHarnessLimitSignal("claude-code", { text })` returns a signal for a synthetic API-error line, emit one `status` chunk `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify(signal)}` and resolve the turn exactly once (reuse the `signalApiError` resolution path at `:1489-1505`; do not register a card).
- Add a per-turn `limitSignaled` guard so a persistent pane notice does not re-emit every tick.
- The structured signal carries `reason`, `resetAtMs` (from `parseClaudeResetNotice`, null when unsure), `message` (the notice text, no token/email), `source`.
- `CLAUDE_API_ERROR_STATUS_PREFIX` text still flows; the orchestrator's backstop classifier handles 429/402; 529/400/network remain non-limits.

**Codex (`codex-tmux.ts`).**
- In the mapper for `turn.failed`/`error`, when the message classifies, emit the same structured status before resolving. Keep the existing `status`/`stderr` behavior otherwise.
- Do not classify `server_overloaded`, `model_not_found`, 5xx/529, auth, or network.

**Fake seams (`agents.ts`).**
- `AGETOR_FAKE_CLAUDE_LIMIT=1` (or a prompt marker `__agetor_fake_claude_limit__`) makes the fake Claude driver emit one `HARNESS_LIMIT_STATUS_PREFIX` signal and resolve with code 0; a second turn on the same task (the swap run) succeeds. Add a turn counter so the e2e can limit once. The limit turn emits a harmless `tool_use` chunk before the signal (so the e2e exercises the **transfer** branch); a companion marker/scenario emits no tool_use for the **clean-retry** test.
- A transcript seam `AGETOR_FAKE_CLAUDE_TRANSCRIPT=1` (or the same prompt marker) makes the fake driver generate a session id and write a minimal JSONL at the harness's `CLAUDE_CONFIG_DIR` standard path (using `encodeProjectPath`), plus a sidecar dir, so the transfer is real in e2e. Never write to the real `~/.claude`: the e2e uses alias homes only.
- A Codex fake limit marker (`AGETOR_FAKE_CODEX_LIMIT=1` or a prompt marker) for the adapter tests.

**Acceptance.** One signal per turn; notice → `quota`; 429 → `rate_limit`; 402/credit → `insufficient_credits`; 529/400/auth/network → no signal; fake limit + transcript; existing `agents.test.ts` unaffected unless a marker is set.

#### T07 — API and payloads

Routes (`src/bun/server.ts`, `ROUTE_POLICY` `app+cli`):
- `GET /harness-stacks` → `{ stacks: HarnessStack[], limitStates: HarnessLimitState[] }`.
- `POST /harness-stacks` body `{ label, kind, members: string[], mirrorMode?: "full"|"safe" }` → 201 `{ stack, warnings, mirror: { copied, warnings } }`; 400 `{ error, blockers }` on a hard block.
- `GET /harness-stacks/:id` → `{ stack, limitStates }`.
- `PATCH /harness-stacks/:id` body `{ label?, members?, mirrorMode? }` → `{ stack, warnings, mirror }`; validates the full ordered list; re-mirrors new members / a changed primary.
- `DELETE /harness-stacks/:id` → `{ removed: true }`; clears task states referencing it.
- `PATCH /tasks/:id` gains one guard: an `agent` change **within the same stack** while `runs.hasRunning(taskId)` returns 409 `{ error: "stop the run before switching accounts" }` instead of killing the run under the user. An outside-stack switch keeps today's behavior and its existing guards. A profile-bound task's PATCH remains refused (the existing 409) — the UI's AgentSelect is disabled for bound tasks; the stack swap path changes `task.agent` internally, not through the PATCH.
- `GET /harnesses` adds `stacks` and `limitStates` (cheap DB reads after `checkAllHarnesses`).
- `GET /tasks` already includes `Task.harnessState` via `toTask`; no route change.
- `GET /harnesses/:id/usage`'s task-count `HarnessUsage` stays. Stack membership does not block `DELETE /harnesses/:id`: the FK cascades, so the delete succeeds when no task/profile references the row. The Settings delete confirmation derives the stack membership from the `/harnesses` payload (no new 409 field).

Clients:
- `src/mainview/lib/api.ts`: add `HarnessStacksPayload`, `HarnessStackInput`, `listHarnessStacks`, `createHarnessStack`, `patchHarnessStack`, `deleteHarnessStack`; extend `HarnessesPayload` with `stacks`/`limitStates`.
- `src/cli/api-client.ts`: the same methods and `listHarnesses` return type.

Route-policy test: add the entries; the handlers' body keys (`members`, `label`, `kind`, `mirrorMode`) must not trip the path scanner; if the scanner flags `members`, add `pathParamsExempt` with a reason (harness ids, not paths) — prefer not to need it.

**Acceptance.** All routes work with the CLI token; validation 400/blockers; patch reorder/add/remove; delete clears states; `/harnesses`/`/tasks` payloads; `route-policy.test.ts` green; existing routes unchanged.

#### T08 — Failover engine

`src/bun/harness-failover.ts` exports:
- `recordLimitSignal(harnessId, signal)` → `harness-stacks.setLimitState` (account-global).
- `beginLap(taskId, stackId, position)`, `recordTried(taskId, harnessId)`, `resetLap(taskId)`, `clearFailoverState(taskId)`.
- `planNextMember(task, { now }): Promise<NextPlan>`:
  - `NextPlan = { kind:"next"; member; skipped } | { kind:"all-exhausted"; earliestResetAtMs; skipped } | { kind:"none-usable"; reasons; earliestResetAtMs: number|null; skipped }`.
  - The walk starts after the current position, forward, wraps once; skips ids in `tried` (terminate if all tried), disabled, cooling (`isCooling`), cached-quota exhausted (`harnessQuotaLooksExhausted`), not installed (`checkHarness` cached/fresh for the candidate), login evidence false, model not offered (`getHarnessDiscoveredModels` non-empty and no match; unknown → allow), and CLI floor (`minCliVersionError`).
  - `earliestResetAtMs` = min of hard cooldowns / quota resets of the skipped cooling members.
- `planExhausted(taskId, plan, now)` → persists `harnessState.allExhausted` with `attempts = prior.attempts + (startedThisAttempt ? 1 : 0)`; for `all-exhausted`, `nextAttemptAt` = `earliestResetAtMs ?? now + HARNESS_STACK_RETRY_BACKOFF_MS`, clamped to `[10s, 24h]`; for `none-usable`, schedule only when `earliestResetAtMs` is non-null (a cooling member will reset); a `none-usable` with only disabled/logged-out/model reasons schedules **nothing** and blocks for a manual fix. If `attempts >= 3`, no timer and a "run manually" state either way.
- `armAutoRetry(taskId, at)`, `cancelAutoRetry(taskId)`, `rearmAutoRetries()` (boot; calls `hooks.onAutoRetry`), `reconcilePendingSwaps()` (boot; calls `hooks.onReconcileSwap`).
- `prepareTaskHarness(taskId, { manual: true }): Promise<{ ok: true; moved?: { from; to; note } } | { ok:false; error }>`:
  - no stack → ok.
  - current member usable (enabled, available/installed, login evidence not false, model offered) → reset the lap/all-exhausted (a new manual turn) and return. A cooling member is usable for a manual start (force).
  - current member removed/disabled/logged out → pick the next usable member (forward from the stored position, wrapping), transfer the session via T05 (if a session id exists), upsert the handoff, update `task.agent` + `harnessState` (`lastMove`), return `moved`; if the transfer fails, return an error (block the start, never silently fresh).
  - if a run is live, return ok without moving (the message queues).
- Constants: `HARNESS_STACK_RETRY_MAX = 3`, `HARNESS_STACK_RETRY_BACKOFF_MS = 10 * 60_000`, `HARNESS_STACK_RETRY_MIN_MS = 10_000`, `HARNESS_STACK_RETRY_MAX_WAIT_MS = 24h`, `HARNESS_QUOTA_STALE_MS = 20 * 60_000`.

The orchestrator registers `{ onAutoRetry, onReconcileSwap }` once at module load (the only bridge; the failover module never imports the orchestrator).

**Acceptance.** All lap/skip/plan cases; the earliest-reset wait and 10-min fallback; cap 3; re-arm/reconcile; manual reset; a task archived/deleted no-op; `prepareTaskHarness` moves only for an unusable current member and blocks on transfer failure.

#### T09 — Orchestrator glue

**`ActiveRun`** (`src/bun/orchestrator.ts:293`): add `limitHit: HarnessLimitSignal | null`.

**Chunk handler** (`:2886`): before/after the existing sentinels, parse `HARNESS_LIMIT_STATUS_PREFIX`; for `status`/`stderr` text on codex (and Claude as a backstop), call `classifyHarnessLimitSignal(kind, { text })`; when a signal is found and the handle has none, set `handle.limitHit` and call `recordLimitSignal(taskHarnessId(task), signal)`. Do **not** flip the column; do not treat it as `apiError`.

**Settle hook** (`attachDoneHandler`, `:3307`): at the top of the `.then` (after `active.delete`/cleanup, before `newStatus`/`runs.update`), and again at the top of the `.catch` (a driver reject after a limit signal), if `handle.limitHit` and not `wasCancelled` and the task resolves to a stack:
- call `handleHarnessLimitSettlement({ task, runId, signal, handle })` and return (it owns everything, including recording the run failed/cancelled).
- If not a stack, keep the current behavior (the run settles normally; the cooldown is still recorded for future stacks).

**`handleHarnessLimitSettlement`** (new, ~250 lines, in `orchestrator.ts`):
0. Claim `startingTaskIds` for the task **before any await** (the old run is already out of `active`), so no user message or second send can mint a competing turn. Release it in `finally`; if the new spawn is detached, mirror `startTaskInner`'s claim-transfer pattern so the continuation releases it after `registerActiveRun`.
1. Re-read the task; if archived/deleted, settle the old run failed/cancelled and return.
2. `recordTried(taskId, currentHarnessId)`; `saveStatusLineQuietly(oldRunId, "harness limit reached: <reason> — switching")`.
3. `cancelPendingForTask(taskId, "harness limit reached")`; drop the old session/process (Claude `dropSession`, Codex `dropCodexSession`; the limit notice leaves the Claude REPL paused, so it must be killed); `orphanRunningSubagents(taskId)` and write a status line naming the abandoned background agents.
4. `planNextMember(task)`:
   - `next`: persist `pendingSwap`; emit `Switching to backup…` on the old run; mark the old run `failed` (`endedAt`, exit code), emit `run-status { status:"failed", reason:"harness-swap" }`, keep the task `running`; `await mirrorStack(stack, { source:"swap", targetHarnessId: next.member })` (warnings → status line); decide `hasToolUse = runs.hasToolUse(oldRunId)`: if true, `await transfer` (T05/T12) and block with `harness-swap-failed` on failure (no new run); if false, skip the transfer (the clean-retry branch). Update `task.agent` + `harnessState` + handoff, then call `spawnSwapContinuation({ task, from, to, oldRunId, signal, transferredSessionId? })`; it owns the new-run insert, the notice, the GlobalEvent and the spawn; on spawn failure → block with `harness-swap-failed`.
   - **Messages typed during the swap/start window:** the swap holds `startingTaskIds`, so the per-kind send entries cannot mint a competing run. Add a generic `swapFollowUps: Map<taskId, { text: string; raw: string; at: number }[]>`; when `sendInputInner` sees `startingTaskIds.has(taskId)`, push the line there (do not re-stash to the backlog, do not drop it) and return the task's current run id. `attachDoneHandler`'s normal path drains `swapFollowUps` one at a time after the run settles (a `sendInput` per line, in order), so the user's message executes on the new account. A Stop/delete/archive re-stashes the remaining lines to the backlog and clears the map.
   - `all-exhausted`/`none-usable`: mark the old run failed (`reason:"harness-swap"`), write the exhausted/unusable status line, `updateColumn(taskId, oldRunId, "blocked", "harness-exhausted" | "harness-swap-failed")`, persist `allExhausted`, arm the timer or leave it manual; keep queued follow-ups.
5. Clear `pendingSwap` after `spawnSwapContinuation` has registered the new run/claim handoff; never drain the queue here (the new run's `attachDoneHandler` drains it).

**`spawnSwapContinuation`** (new, per-kind Claude/Codex; owns the new run row, the notice and the spawn):
- **Clean-retry branch (grill 14):** if `hasToolUse` is false (no tool call — an immediate 429/quota, possibly with only an error line), do **not** transfer or resume. Start a fresh session on the new account with `runs.lastUserText(oldRunId) ?? task.prompt` as the prompt; suppress the user echo (the old run already shows the user bubble) and tag the text as a continuation in storage. The old session stays on the old account (a later switch back can resume it; archive/delete cleans it).
- **Transfer branch:** if `hasToolUse` is true, use the `transferredSessionId` from step 4 and spawn with `resumeSessionId`/`exec resume` and the hidden `composeHarnessStackContinuationPrompt()`. Claude's `spawnAgent`/Codex's driver use the explicit id; `onSessionId` updates the run.
- Insert the new run `{ agent: to, status: "running", origin: "harness-swap", claudeSessionId/codexSessionId: transferredSessionId ?? null, tmuxSession }` and point `task.runId` at it in one transaction; `adoptPendingTaskCancel(taskId, newRunId)`; release the `startingTaskIds` claim after `registerActiveRun` (or transfer it to the detached continuation, mirroring `startTaskInner`).
- Emit the swap notice as the new run's first `status` event before the spawn, then the `harness-swap` GlobalEvent, so both are visible even if the spawn fails.
- Never emit an untagged `user` echo on the swap run: Claude's JSONL delivers the tagged prompt (the tailer emits it, the renderer hides it); Codex's one-shot path echoes the tagged prompt and the renderer hides it. A clean-retry prompt is tagged the same way.
- `mode/model/effort/speed/maxMode` come from the task; `task.column` stays `running`; no `column` event if it was already running.

**Success/cancel cleanup:**
- In `attachDoneHandler`'s normal path, when the run is the terminal run and the task has `harnessState`, call `resetLap` (a non-limit terminal turn ends the lap) and `clearLimitState(currentHarness)` on `succeeded`; on `cancelled`, reset the lap and cancel any auto-retry. After the new run's normal settle, drain `swapFollowUps` one line at a time (in order) via `sendInput`; a Stop/archive/delete re-stashes the remaining lines to the backlog and clears the map.
- In `startTaskInner`, call `prepareTaskHarness(taskId, { manual: true })` after the profile copy-down and before `resolveHarness(task.agent)`. In `sendInputInner`, after the imported/`onlyIfIdle` checks and before the codex/copilot CLI-floor pre-flight, handle the start/swap window: if `startingTaskIds.has(taskId)` (a swap or a run start is holding the claim), push the raw `line` to `swapFollowUps`, write the user bubble on the task's current run, and return `{ delivered: true, runId: task.runId }`; otherwise call `prepareTaskHarness(taskId, { manual: true })` **before** the CLI-floor pre-flight (which resolves `task.agent`) and before the archived/worktree side effects; re-read the task after a move. Only when no run is live. If it returns `moved`, the caller writes a `status` line on the next run or leaves the `lastMove` note for the UI. If a `startTask`/swap aborts before a run is minted, its `finally` re-stashes `swapFollowUps` to the backlog (never drops a message).
- `findLastSessionIdForHarness`: compare the newest handoff (`createdAt`) with the newest run on that harness (`startedAt`); return the newer. The non-stack behavior is unchanged.
- `reconcileTaskSession`: if `before.agent` and `after.agent` are both members of the same stack and no run is live:
  - transfer the session (`before` → `after`), upsert the handoff, keep the follow-up queues, drop the old process (`dropSession`/per-kind drop) but do **not** clear the session mapping; write a status line "switched to <label> — continuing this conversation".
  - if the transfer fails, write a warning status line and keep today's fresh-start behavior (manual action, not the automatic-swap fidelity rule).
  - outside a stack or cross-kind: today's behavior (kill session, clear queues, reset model/mode) **plus** `clearFailoverState(taskId)` and delete the task's session handoffs (the copied files are no longer part of the task's conversation).
  - if a run is live and the switch is inside the stack, refuse at the route with 409 before the update (T07 uses `runs.hasRunning(taskId)`; the UI disables the select).
- `archiveTask`: `clearFailoverState(taskId)` + `cancelAutoRetry`; the copied session files stay on disk so an unarchive can still resume, and the retention sweep removes them after the archived-history threshold. `deleteTask`: `clearFailoverState(taskId)`, `cancelAutoRetry`, and `cleanupHarnessSessionCopies(taskId)` **before the task row is deleted** (the handoff rows cascade with it, so they must be read first). `retention.ts` removes the copies of archived tasks past the retention threshold. Every removal validates the recorded path is below the destination account's config dir and is a regular file/dir.
- `fireHarnessAutoRetry(taskId)` (registered as T08's `onAutoRetry` hook): re-read the task, verify the persisted `nextAttemptAt`/`allExhausted` identity, ensure no run is live, pick a usable member (the T08 planner, with `tried: []`), decide transfer vs clean retry from the last run's `hasToolUse`, transfer if needed, and call `spawnSwapContinuation` with `origin:"harness-swap"`. If the picked member is the **current** account (its reset expired, no switch), skip the mirror/transfer no-op and write a plain `Retrying on <label> after the quota reset…` status line instead of the `Switched to…` notice (`to === from` would be misleading). Increment `attempts` only when a run starts; clear `allExhausted` on a later success; if no member is usable, re-arm at the new earliest without incrementing, or leave the task blocked at the cap.
- Boot: `index.ts`/`headless.ts` call `reconcileHarnessFailover()` after `reconcileOrphans()`/`reconcilePipelineRuns()` and before/with `rearmFxAutoResumes()`; it completes/block-clears pending swaps, re-arms retries, and prunes expired cooldowns.

**Acceptance.** The scenarios in §5 (swap happy path, queue/cards/subagents, stop/archive/delete, transfer/spawn failure, all-exhausted, manual force, manual switch, boot, cleanup, non-stack regression).

#### T10 — Pipeline and notifications

- `pipeline-runner.ts`'s subscriber: ignore `run-status` with `reason === "harness-swap"`; the new run's settle is the step's outcome. `handleColumnChange`'s `blocked` branch currently calls `upsertBlocked` and persists; add `reasonMessage` cases for `harness-exhausted`/`harness-swap-failed`, then verify the existing `running` branch clears that block for a non-stopped step (the auto-retry's `running` event). Add a test that the parent stays on the same run and the retry's `succeeded`/`failed` settles it. Only if the test shows the existing `running` branch refuses a non-stopped step, add a narrow "clear a harness-exhausted block" branch — do not change the stopped-step semantics.
- `headless-notifications.ts`: `run-status` with `reason:"harness-swap"` → null; `column` blocked with `harness-exhausted` → "Stack out of quota" body and `harness-swap-failed` → "No usable backup account"; the `harness-swap` GlobalEvent → a notification with the from/to labels (quiet; no email/token).
- `App.tsx`/`toasts.ts` (T15) mirrors the same policy in the webview; T10 owns only the Bun/headless side.

**Acceptance.** A step swap does not fail the step; the parent reflects the retry; notifications are correct and the old run is silent.

#### T11 — Codex HOME / overlay

- **If T00 says `CODEX_HOME` alone isolates** (expected): `harnessEnv` for codex emits only `CODEX_HOME` and no `HOME` (the real HOME is preserved). Update `Harness.home`'s doc comment, `docs/architecture/harnesses.md`, `docs/architecture/harness-codex.md`, `agents.test.ts` (the codex alias env test), and the README note. This applies to every codex account, not only stack members — call it out in the PR body.
- **If T00 says HOME is needed:** build `createCodexHomeOverlay(harness)` at `<home>/.agetor-home` with symlinks to the fixed allowlist from the real HOME: `~/.gitconfig`, `~/.gitignore_global`, `~/.ssh`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`. Skip a missing target. The overlay is user-only and never merges `CODEX_HOME`/XDG state. `harnessEnv(harness, { stackMember })` returns `HOME=<home>/.agetor-home` only for stack members; `buildCommand`/`spawnAgent`/`checkHarness`/`harnessShellEnv` pass `stackMember` from the stack lookup. `CODEX_HOME` stays per account. No overlay for non-stack accounts (today's HOME override stays).
- **If T00's stale-DB arm fails and `migrate-rollouts` does not fix it:** stop and escalate (§8); do not ship a broken Codex train.
- **Worktree trust:** if T00 says `codex exec` needs a `[projects."<cwd>"]` trust entry in the destination, the swap adds that one entry for the task worktree to the destination `config.toml` (a narrow, path-validated write), never the primary's other `[projects.*]` entries.

**Acceptance.** The env per verdict; the overlay's links only the allowlist; a missing target is skipped; no credential file; existing codex tests updated; docs.

#### T12 — Codex session transfer adapter

- Find the rollout for `threadId` under `<fromCodexHome>/sessions/**/rollout-*-<threadId>.jsonl` (validate regular file below a plain dir; size cap).
- Copy to the same relative path under `<toCodexHome>/sessions/...` (atomic, 0600).
- If `<toCodexHome>/thread_history_*.sqlite` exists, apply the T00 verdict: if the projection shadows the rollout, run `coreSpawn(codexBin, ["migrate-rollouts", "--apply"], { env: childEnv(harnessEnv(toHarness)), cwd: toCodexHome })` with a 30 s timeout; a failure is a warning, and if the resume then fails, the swap blocks with a clear message (never a silent fresh session).
- If a `mcp_oauth_credentials_store = "file"` standalone token file is identified by T00, add it to the mirror's tool-auth copy list (not the adapter); otherwise emit the "MCP sign-in must be repeated" warning.
- Record the handoff (`column: "codex_session_id"`, copied paths); delete cleans immediately, archive keeps the files until the retention sweep (same rule as Claude). Register the Codex adapter in T05's `cleanupHarnessSessionCopies` dispatcher.
- `no-session` when no rollout matches.

**Acceptance.** A copied rollout resolves (fake/real opt-in); a missing rollout → `no-session`; stale-DB handling per verdict; cleanup; the adapter never reads `auth.json` into the copy set.

#### T13 — CLI

- `agetor harness stack ls` — columns: id, label, kind, members (`label · 1/3`), mirror mode; `--json` returns the payload.
- `agetor harness stack create <label> --kind <claude-code|codex> --member <id>... [--mirror full|safe]`.
- `agetor harness stack show <id>` — members in order, warnings, limit states.
- `agetor harness stack edit <id> [--label] [--member <id>...] [--mirror full|safe]` — the member flags define the full order; no `--member` leaves members unchanged.
- `agetor harness stack rm <id>`.
- `agetor harness ls` — a `stack` column (`2/3`), a cooling marker (with `escapeControlChars`).
- `agetor ls` — `agent` cell `label · 2/3` (only when in a stack; otherwise today's value).
- `agetor show` — `stack: <label> (2/3)`, `failover: waiting until <time> (attempt 1/3)` when all-exhausted; runs list unchanged.
- `agetor logs` — format `HARNESS_SWAP_STATUS_PREFIX` as the exact notice (not raw JSON), skip the hidden continuation, keep all existing status handling.
- TUI `Dashboard.tsx` — the same status formatting; `useGlobalEvents.ts` toast for `harness-swap` and the `harness-exhausted` blocked reason; the active account/position in the task header.
- All free text through `escapeControlChars`/`escapeFreeText`.

**Acceptance.** The CLI tests: create/list/edit/remove/order; positions; countdown; notice; hidden prompt skipped; a label with control chars is escaped.

#### T14 — Settings

- `settings-dialog-view.ts`: add `{ id: "stacks", label: "Stacks" }`; `SettingsView` gets `{ kind: "stack-editor"; stackId: string | null }`; `activeSection` → `"stacks"`; `backFromSubview` → stacks; `resolveEscape` pops; `isFormSubpage` true for the editor. Update the tests.
- `HarnessStacksSection.tsx`: list stacks, "New stack", edit/delete; the editor: label, kind (only claude-code/codex), member picker (same-kind accounts; accounts already in another stack are disabled with a reason), ordered member list with dnd-kit drag, mirror mode radio (Full / Safe subset), blocker/warning panels, the hooks/permissions warning, the >10 warning, and a "Primary" label on position 0. Save POST/PATCH, delete with a confirmation that says tasks keep their current account and failover stops.
- Virtualize the member list for >20 rows with a small fixed-row window in `src/mainview/lib/stack-editor.ts` (pure math + tests); the list is scrollable and the drag handles work.
- `SettingsDialog.tsx`: render the section; in the Harnesses section show a stack chip (`2/3`) and a cooling badge ("cooling until <time>") per row, linking to the editor; the account delete confirmation mentions the stack membership.
- Keep `RunPanel` untouched in this task.

**Acceptance.** `stack-editor.test.ts` (draft validation, add/remove/reorder, >10, virtual window math, blockers vs warnings); `settings-dialog-view.test.ts` (navigation/escape/dirty); e2e settings spec.

#### T15 — Task surfaces

- `StackBadge.tsx`: a small `link` + `2/3` chip, optional cooling/warning dot, `title` with the stack label and "fails over to the next account at its limit".
- `NewTaskForm`/`TaskLaunchPickers`: pass `stacks`, render the badge next to each account; selecting an account does not change.
- `RunPanel`: accept `stacks`/`limitStates`; show the active account line `label · 2/3` in the task details; when `task.harnessState.allExhausted`, a banner with the countdown (a `useCountdown` local hook, reset on `[task.id]`) and a "Run now" action; when `pendingSwap`, "Switching to <label>…"; render a `harness-swap:` status as a `StatusDivider` with the formatted text + a `2/3` chip; skip `isHarnessStackContinuation` user events; a `lastMove` note ("moved to <label> — <from> left the stack/ was disabled") while the state is recent; no new child key collisions; the reset effect.
- `TaskCard`: the badge from `harnessState` or the account's stack; a warning dot when all-exhausted/cooling.
- `App.tsx`: handle the `harness-swap` GlobalEvent → `toastHarnessSwap` (skip if the task is selected/focused; OS notify when unfocused); skip the old run's failed toast when `run-status.reason === "harness-swap"`; map `column.reason === "harness-exhausted"` to a "Stack out of quota" toast and `"harness-swap-failed"` to a "No usable backup account" toast; pass `stacks`/`limitStates` from the `/harnesses` payload.
- `toasts.ts`: `toastHarnessSwap` (info, self-dismissing, `maybeNotifyOS` with the `harness-swap` kind).
- `event-search.ts`/`message-history.ts`: skip hidden continuations; index the formatted swap notice.
- TUI is T13; the webview only.

**Acceptance.** `harness-stack-view.test.ts` (position/count, countdown copy, notice parse/format, no product name); event-search/message-history tests; e2e DOM.

#### T16 — Docs

- New `docs/architecture/harness-stacks.md`: model, DB/state, selection/lap, limit signals/cooldown, swap settlement, transfer, mirror/allowlist/security, all-exhausted, boot, CLI/UI, tests.
- Update `CLAUDE.md` (topic map row; session-id exception; no-added-text exception; the "never copy harness credentials" / "no-follow/atomic" rules; the codex HOME note), `README.md` (a "Harness stacks" section, failover, limits, machine-local/no bundle, Codex HOME), `harnesses.md` (session handoff exception, codex HOME), `task-lifecycle.md` (prepare hook, swap, reasons), `persistence.md` (new tables/column, `harness_state`), `security.md` (mirror/transfer rules), `harness-claude-code.md` (notice signal, transcript/sidecars), `harness-codex.md` (HOME/overlay, rollout, thread_history), `run-panel.md` (account line, banner, notice, hidden prompt), `notifications.md` (`harness-swap`), `agent-profiles.md` (profile-bound active account vs frozen harness), `pipelines.md` (steps inherit; swap run-status ignored), `bundle.md` (stacks not exported), `docs/architecture/README.md` (citation map if needed).
- Finish `docs/plans/harness-account-stacks-security-review.md`: sign off or record the safe-subset fallback.

**Acceptance.** `claudemd-citations.test.ts`; no broken links; docs match the tests; the security review has a verdict.

#### T17 — E2E

`e2e/harness-stack-swap.spec.ts`:
- Seed two Claude alias accounts (`claude-a`, `claude-b`) with homes under the e2e data dir; write a dummy `.credentials.json` in each home (the fake driver ignores it; the mirror asserts it is never copied).
- Create a stack `[claude-a, claude-b]` via the API; create a task on `claude-a` with the fake limit marker; the fake driver writes a JSONL, emits a harmless `tool_use`, then a limit on the first turn, and succeeds on the second (the transfer branch). A second test uses the no-tool-use marker and asserts a fresh session (the clean-retry branch).
- Assert: the task stays `running` through the swap; the task stream contains the swap notice after the first run's events and before the second run's assistant output; the second run's `claude_session_id` is the copied id; the second home contains the copied transcript + sidecar; the continuation prompt is not rendered as a user bubble; the task reaches `review`/`succeeded`.
- Assert the old run's failed toast is not shown (via the absence of the toast test id or the event reason).

`e2e/harness-stack-settings.spec.ts`: Settings → Stacks create/edit/reorder/delete; the member picker excludes different kinds; the >10 warning; the Harnesses section badge; the New Task badge.

`e2e/fixtures.ts`: add the fake transcript/limit env or use prompt markers; no real accounts; ensure `AGETOR_CLAUDE_BIN=/bin/echo` and `AGETOR_TMUX_BIN=/bin/echo` still satisfy the pre-flight; the alias homes are under the temp data dir.

**Run recipe:** `bun run typecheck`; `bun test`; `bunx playwright test e2e/harness-stack-swap.spec.ts e2e/harness-stack-settings.spec.ts` (and the full e2e in T18 if time). The fixture starts `src/bun/headless.ts` with the fake Claude driver, `AGETOR_HARNESS_AUTO_ENABLE=0`, a temp data dir; no credentials.

#### T18 — Final green

- Run `bun run typecheck`, `bun test`, and the full `bunx playwright test` where feasible; at minimum the two new specs plus every spec whose surface the change touched (`run-panel`/task details, settings, events, notifications, pipeline). Run the opt-in Codex spike only if the owner allows a real binary.
- Refresh the plan's `Status`, the PR body, test counts, and any generated report; ensure no test is skipped except `AGETOR_REAL_CODEX`.
- Report defects against the owning task; do not paper over a red suite by loosening a test.

---

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned test files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit (shared) | Lap/wrap/skip/success reset; classifier table; notice formatter; tag; allowlist; notification kind. | `src/shared/harness-stack.test.ts`, `harness-limits.test.ts`, `harness-mirror.test.ts`, `user-message.test.ts`, `types.test.ts` | Every union variant and negative path; each test is shown red against a deliberately broken copy. |
| TT2 | integration (DB) | 084 migration, `tasks.setHarnessState` patch-proof, handoffs, `runs.lastUserText` plan, harness/task delete cascades, snapshot restore. | `src/bun/db-harness-stacks.test.ts`, `migrate.test.ts`, `db-run-events-plans.test.ts` | Applies on 083; plan test green; deletes clean; snapshot restores. |
| TT3 | integration (store) | Stack CRUD/order, validation blockers/warnings, effective home, login evidence, cooldown expiry, orphaned member. | `src/bun/harness-stacks.test.ts` | Each hard block and warning; reorder; delete clears states. |
| TT4 | integration (files) | Mirror merge/fixtures, never-copy, env strip, safe mode, TOML, symlink/FIFO/oversize, atomic/0600, idempotence; Claude transfer/sidecars/cleanup; Codex rollout. | `harness-mirror.test.ts`, `harness-file-transfer.test.ts`, `harness-session-transfer.test.ts` | A planted symlink/FIFO/credential path can never be read/copied; destination bytes/mode; cleanup bounded. |
| TT5 | integration (runtime) | Fake-driver swap happy path; clean-retry (no tool call) vs transfer (tool call); queues/cards/subagents; stop/delete; transfer/spawn failure; all-exhausted; manual force; manual switch; boot; retention cleanup; non-stack regression. | `orchestrator-harness-swap.test.ts`, `orchestrator-harness-exhausted.test.ts`, `orchestrator-session-harness.test.ts` | The "assembled flow" tests drive `startTask`/`sendInput`/`attachDoneHandler` through the production entry points and assert the task/run/event/DB output. |
| TT6 | integration (API/events) | Stack routes, payloads, route policy, pipeline swap ignore, notifications. | `server-harness-stacks.test.ts`, `route-policy.test.ts`, `pipeline-harness-swap.test.ts`, `headless-notifications.test.ts` | 400/blockers; CLI token; payloads; step stays running; old run silent. |
| TT7 | unit (CLI/UI pure) | CLI parsing/formatting, log formatting, TUI toast, settings draft/virtual math, position/countdown/notice, search/history filters. | `harness.test.ts`, `ls.test.ts`, `show.test.ts`, `logs.test.ts`, `Dashboard.test.tsx`, `useGlobalEvents.test.ts`, `stack-editor.test.ts`, `harness-stack-view.test.ts`, `event-search.test.ts`, `message-history.test.ts`, `settings-dialog-view.test.ts` | Each variant through its renderer; escaped free text; hidden prompt skipped. |
| TT8 | e2e | C2/C3/C5 assembled user flow; settings. | `e2e/harness-stack-swap.spec.ts`, `e2e/harness-stack-settings.spec.ts` | Fake limit → notice → backup → preserved session → success; settings create/edit/badge. |
| TT9 | real binary (opt-in) | Codex `CODEX_HOME` isolation + stale `thread_history` + MCP OAuth store. | `src/bun/codex-home-spike.test.ts` | Skips loudly without `AGETOR_REAL_CODEX=1`; records the verdict; never prints a token. |

**E2e applicability: applies.** The change has a user-visible flow (`Settings → Stacks`, task transcript, swap notice) and crosses process boundaries (webview → API → DB → CLI child → provider session files). The app runs locally with fake drivers; no real account is required. **Run recipe:** `bun run typecheck`, `bun test`, `bunx playwright test e2e/harness-stack-swap.spec.ts e2e/harness-stack-settings.spec.ts`; the Playwright fixture starts `src/bun/headless.ts` with a temp `AGETOR_DATA_DIR`, `AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_CLAUDE_BIN=/bin/echo`, `AGETOR_TMUX_BIN=/bin/echo`, `AGETOR_HARNESS_AUTO_ENABLE=0`; seed the two alias accounts and the stack through the API; no credentials.

**Tests must be able to fail.** Every new test is observed red against a broken copy of the behavior (a disabled swap, a copied credential, a hidden user message, a skipped lap). A missing database/dir/env must skip loudly and fail in CI, never return early and pass. The real-binary Codex test is the only opt-in skip.

**Test hygiene (repo rules).** Every new `src/bun/*` test that imports `db.ts`/`orchestrator.ts` sets `AGETOR_DATA_DIR` to a `mkdtemp` at the **top level** of the file, loads the modules with `await import`, calls `snapshotHarnessState()` after `db.ts` and restores in `afterAll`, and cleans up with `rmTestDataDir`. A test that inserts/removes a harness, stack or limit state restores it. `bun test` runs every file in one process; a leaked stack/limit/harness row will make a later file fail. The e2e fixture owns its own temp `AGETOR_DATA_DIR`.

---

## 6. Execution waves

| Wave | Tasks (parallel, file-disjoint) | Barrier / checkpoint |
| --- | --- | --- |
| 0 | T00 (spike; docs + opt-in test) — runs alongside Wave 1 but gates T11/T12. | Spike verdict recorded. |
| 1 | T01 (data/migration), T02 (shared contract). | `bun run typecheck` + `bun test` green; migration pin; pure tests. |
| 2 | T03 (store), T04 (transfer/mirror engine, imports T03's pinned `effectiveHome`), T05 (Claude adapter, imports T04's pinned engine), T06 (limit detection/fake). | Unit/integration tests green; no runtime swap yet; API still absent. |
| 3a | T07 (API), T08 (failover engine; imports T03/T05). | `route-policy` + stack-route tests + failover-engine tests; no swap wiring yet. |
| 3b | T09 (orchestrator glue; imports T08's pinned plan/prepare API), T10 (pipeline/notifications; codes against T02's event contract and can test with a synthetic `run-status` reason before T09 lands). | Backend assembled flow green with fake drivers; `orchestrator-harness-swap`/`exhausted`; `pipeline-harness-swap`; no UI/CLI yet (API test client). |
| 4 | T11 (Codex HOME/overlay), T12 (Codex adapter) — only after T00. | Codex adapter tests + env tests; the real-binary test remains opt-in. |
| 5 | T13 (CLI), T14 (Settings), T15 (task surfaces). | CLI/UI unit tests; `bun run typecheck`. |
| 6 | T16 (docs/security sign-off), T17 (e2e), T18 (final green). | Full `bun test`; the two e2e specs; docs/citations; plan status. |

**Security-review gate.** T04 writes the mirror security review; the owner/reviewer must sign it **before Slice B is merged** (not only at T16). If it rejects hooks/permissions, flip the `mirrorMode` default to `safe` in T04/T14 and record the ratification in the PR body before T07/T09 wire the mirror into the create/swap paths.

**Pinned interfaces between same-wave tasks** (the only cross-task symbols a task may import before its sibling lands):
- T01 ↔ T02: `parseTaskHarnessState(raw)`, the `HarnessStack`/`HarnessLimitSignal`/`TaskHarnessState` types, and the status prefixes.
- T03 → T04/T05/T08: `effectiveHome(harness)`, `HarnessStack` (T02), `resolveForTask(task)`.
- T04 → T05/T07/T09: `atomicWriteFile(path, data, {mode})`, `copyRegularFile(src, dest, {maxBytes})`, `copyTreeCooperative(srcDir, destDir, opts)`, `assertNotCredentialPath(rel, spec)`, `mirrorStack(stack, opts)`, `removeCopiedPaths(paths, {root})`.
- T05 → T08/T09: `transferSession(args)` / `cleanupHarnessSessionCopies(taskId)`; the adapter's `TransferResult` shape.
- T08 → T09: `planNextMember(task, opts)`, `planExhausted(taskId, plan, now)`, `armAutoRetry`, `cancelAutoRetry`, `prepareTaskHarness(taskId, {manual})`, `HARNESS_STACK_RETRY_*`.
- T09 → T10: the `GlobalEvent` `run-status.reason`/`column.reason` values and the `harness-swap` event shape (all in T02); T10 does not import T09's internals.
- T07 → T13/T14/T15: the `HarnessStack` API payloads and client methods.
If a pinned signature changes, the owning task updates every importer in the same commit, not the next wave.

**Delivery slices (stacked PRs, dependency order):**
1. **Slice A — contract + data:** T01 + T02 (migration/tables/pure contract). Nothing user-visible; green.
2. **Slice B — stack store + safe files + Claude adapter + limits:** T03 + T04 + T05 + T06 (and T00's doc if ready). The API is still absent; the tests exercise the modules.
3. **Slice C — API + failover engine:** T07 + T08. The API is usable via tests/CLI primitives; no swap settlement yet.
4. **Slice D — failover runtime + pipeline/notifications:** T09 + T10. This is the first end-to-end backend slice (Claude); review the swap settlement and the security review together.
5. **Slice E — Codex:** T11 + T12 (after the spike verdict).
6. **Slice F — CLI + UI:** T13 + T14 + T15.
7. **Slice G — docs + e2e + final:** T16 + T17 + T18.

Each slice must build, typecheck, and pass its tests; no slice may delete or leave unwired a module it doesn't use. The final PR description names the T00 verdict and the security review outcome.

---

## 7. Invariants, runtime shape & risks

### Invariants and their single enforcement point

| Invariant | Enforced at | Every path through |
| --- | --- | --- |
| An account belongs to at most one stack. | `UNIQUE(harness_stack_members.harness_id)` in 084 + `harness-stacks.validateInput`. | Every create/edit route and CLI command. |
| A task's stack is derived from its current account; a task has at most one stack. | `harness-stacks.resolveForTask` (state `stackId` first, then `getByMember`). | Start, send, settle, boot. |
| One in-flight run per task; a swap is a new run on the same task. | `startingTaskIds` + `active` in `orchestrator.ts`; the swap path claims `startingTaskIds` before any await and releases in `finally`. | `startTask`, `sendInput`, swap, retry. |
| Session ids are scoped to the harness that created them, except a recorded handoff. | `findLastSessionIdForHarness` compares the handoff and run timestamps. | Every resume path for every kind. |
| Harness credential files are never copied. | `NEVER_COPY`/`assertNotCredentialPath` in `harness-mirror.ts` + the T04 tests. | Mirror at create/update/swap; no other copy path. |
| Agent-writable reads are no-follow/regular; writes are atomic/user-only. | `harness-file-transfer.ts` using `no-follow.ts`. | Mirror, transfer, cleanup. |
| A limit is conservative: quota/429/402 only. | `classifyHarnessLimitSignal`. | Claude notice/API error, Codex error, fake drivers. |
| A member is tried at most once per lap; a success resets the lap. | `harness-failover.recordTried`/`resetLap` + `pickNextMember`. | Every limit/retry. |
| Cooldowns are account-global. | `harness_limit_state` keyed by `harness_id`; all writes go through `harness-stacks.setLimitState`. | Limit signal, manual force, success clear, boot prune. |
| A task is never left `running` without a live run after a crash. | `TaskHarnessState.pendingSwap` + `reconcileHarnessFailover` on boot. | Boot in `index.ts`/`headless.ts`. |
| The user-visible transcript is `run_events`; the swap notice is a `status` event. | `saveAndEmit` + the notice formatter. | Swap settlement, RunPanel/CLI/TUI. |
| A hidden continuation prompt hides only the exact wrapper; a user message that merely contains the tag is shown. | `isHarnessStackContinuation` requires the whole text to be the exact wrapper; `runs.origin` records the swap run for history/telemetry. | RunPanel, CLI, TUI, search, history, JSONL rebuild. |
| No product name, email or token in a notice. | `formatHarnessSwapNotice` uses labels only; `terminal-text` escaping. | All renderers. |

### Runtime shape

- **Instances:** one Bun core owns the DB/API; the desktop app and a headless/background core hand the port over. A swap holds in-memory `startingTaskIds`/timers that do not survive a handoff; the persisted `pendingSwap`/`allExhausted` state and the boot reconcile cover it.
- **Crash between steps:** old run failed + `pendingSwap` persisted + no new run → boot completes the transfer/spawn if the task is still there and not archived, else clears the intent and leaves a visible status. Old run failed + new run inserted + not spawned → `reconcileOrphans` marks the new run `orphaned`; the boot reconcile sees `pendingSwap` and either retries once or blocks with `harness-swap-failed` (no loop).
- **Dependency outage:** the provider is the dependency. 5xx/529/network are not limits; the existing blocked/ready behavior applies. The backup is not burned on an account-independent outage.
- **Kill switch / rollback:** no global flag. Deleting the stack makes every task inert at its next selection; the current account keeps running. `mirrorMode: "safe"` is the per-stack security opt-out. The migration is additive; no data rollback is needed.
- **Blast radius:** every task start/send (`prepareTaskHarness`), every settle (`attachDoneHandler`), `reconcileTaskSession`, `findLastSessionIdForHarness`, `tasks` poll JSON, `/harnesses` payload, the codex `harnessEnv` (T11), the pipeline runner's `run-status` handling, notifications, CLI/TUI, the migration, and the docs. Non-stack behavior must be byte-identical; the existing session-scoping test is extended, not replaced.
- **Cross-repo dependencies:** none.

### Risks

- **Duplicate tool side effects** on a mid-turn resume (the provider may re-run a tool whose result was lost). The owner accepted mid-turn continuation (grill 14/16); the notice says "Continuing from the transferred conversation", and the continuation prompt tells the model not to repeat completed steps. Document in `harness-stacks.md`; do not silently retry a tool result on the Agetor side.
- **A false limit classification** can burn the backup. The classifier is conservative and table-tested; 529/5xx/auth/network are explicit negatives.
- **A backup with a lower plan/model** can't run the task's model. The selection skips a member whose known catalog excludes the model; unknown catalogs fail open; a real failure blocks with the provider message rather than looping.
- **A profile-bound task's frozen snapshot** still names the original harness while `task.agent` moves. The UI shows the profile badge and the active-account badge separately; the prompt kind is unchanged (same-kind stack), so the model/effort remain valid.
- **Agent-writable homes** can plant a symlink/FIFO/oversized file. The T04 guards (no-follow, regular-file, size caps, atomic rename) are the mitigation; a planted transcript from another account is not copied unless the task's own session id and path validate.
- **Codex stale `thread_history`** can shadow a copied rollout. T00 decides; T12 implements `migrate-rollouts` or blocks with a clear message. This is the one unresolved technical premise; see §8.
- **Codex MCP OAuth** may live in a DB, not a standalone file. If so, the mirror cannot copy it safely; the swap warns that the account must sign in again. This is a deviation from "mirror MCP OAuth" for one kind; see §8.
- **Hooks/permissions mirror** executes the primary's hooks on every backup. The security review and the `safe` mode are the mitigations; the owner chose full mirror.
- **Mirror/copy latency** can make the swap gap seconds. The task stays `running`; the status line explains; the copy is cooperative so other tasks keep running.
- **A user message typed during the swap** lands in `swapFollowUps` (with its visible bubble on the old/current run) and drains after the new run settles; it cannot start a competing turn because `startingTaskIds` is held. A Stop/delete/archive re-stashes it to the backlog. Test it.

---

## 8. Open questions / assumptions

**Unratified one-way outcomes (put these in the PR body for the owner/reviewer):**
1. **Codex HOME global change (if T00 says drop HOME).** The grill chose "test dropping it first", but applying it changes the tool environment for *every* existing codex account (real `~/.gitconfig`/`~/.ssh`/`gh` become visible; the account's `<home>` no longer pretends to be HOME). The plan applies it only if T00 proves `CODEX_HOME` isolation. If the owner wants stack-only behavior, use the overlay for all codex accounts or keep HOME and build the overlay; this is a product call, not a code call.
2. **Codex MCP OAuth if the store is a DB.** The owner asked to mirror MCP/plugin OAuth. If T00 finds the tokens in `state_*.sqlite` rather than a standalone file, copying rows is unsafe; the plan warns and requires a per-account sign-in. The owner should ratify this narrow deviation or ask for a DB-row copy follow-up.
3. **Hooks/permissions security review.** The owner chose `mirror-everything`. If the security review rejects hooks/permissions, the plan's fallback is `mirrorMode: "safe"` as the default for new stacks (the editor still offers full with a warning). The owner should ratify the default change; do not silently flip it.
4. **Mirror source = position 0.** The grill says "the primary wins" but does not define primary if the user reorders or if the built-in is not first. This plan defines primary = position 0 (the UI labels it "Primary"). If the owner meant "the built-in account", the mirror source must change; the stack editor should label it explicitly.
5. **The task's current account is the starting point of the train.** Grill 29's "selection starts at the first enabled, logged-in member" is read as the stack's order/head (the wrap target), not as an override of the account the user picked for a task. A new task starts on its selected account (or its profile's harness); failover walks forward from there. If the owner meant "always start every task on the stack's first member", that is a different selection rule and must be stated before implementation.

**Assumptions being proceeded on (with the source):**
6. A stack may be created with 0 or 1 members; it is inert (no failover) and the editor warns. The owner said opt-in by creating a stack; allowing the shell before adding backups is the least surprising.
7. All-exhausted wait: exact earliest reset; if null, 10 min; re-arm at most every 24 h; cap 3 run attempts; a manual Run resets the cap. (fx precedent, `FX_AUTO_RESUME_MAX = 3`, `FX_AUTO_RESUME_DEFAULT_DELAY_SEC = 120`; the 10 min is a harness-stack choice, not an fx reuse.)
8. Claude reset-time parsing (`at 8am`, `at 3:30pm`) is best-effort; an unparsed notice uses the 10-min backoff. The exact wording is version-dependent; the classifier tests pin the current notice forms.
9. The provider session can be copied and resumed at the standard path (S1/S2). If the run recorded a `tool_use`, a transcript whose last entry is a tool_use may re-run the tool on resume — accepted and documented. If it recorded **no** `tool_use`, the clean-retry branch starts a fresh session with the original prompt, avoiding both a synthetic continuation and a duplicate provider user message.
10. The task row's `harness_state` is small (ids/timestamps/notes), never prompts or tokens; `/tasks` poll size is bounded.
11. `runs.origin = "harness-swap"` is enough to identify a swap run in history; the hidden prompt's tag is the cross-surface renderer guard.
12. The mirror's full mode copies `settings.json`/`config.toml`, MCP definitions, skills/commands/agents/plugins and user-level hooks/permissions; it does not copy sessions, caches, logs, credentials, or `[projects.*]` trust. The security review enumerates the exact paths.
13. The built-in Claude account is usable as a stack member with no login evidence (`null` = keychain, never block); the start pre-flight still refuses if the CLI positively reports logged out.
14. The e2e fake Claude driver can write a minimal transcript to the alias home; no real account or real `~/.claude` is touched.
15. `Bun.TOML.parse` is available (checked) and the section merge is valid; no new dependency.
16. The topbar keeps one chip per account (grill 28); the cooldown is shown in Settings/RunPanel/TaskCard, not grouped in the topbar.
17. The stack editor's virtualization is a small fixed-row window, not a new dependency; >10 members shows a warning but is allowed.
18. A manual switch inside the same stack preserves the conversation; a manual switch outside resets. A manual switch while a run is live is refused at the route (409) rather than killing the run.
19. Delete removes the copied provider-session files immediately; archive keeps them until the archived-history retention sweep, so an unarchive can still resume; retention removes archived copies after the threshold. This is the security requirement (don't keep copies forever) without breaking unarchive-resume. The grill's "clean them up on archive/delete/retention" is satisfied by the retention-on-archive rule.
20. No new event type is added for the transcript notice; the structured notice rides the `status` stream. The `harness-swap` GlobalEvent is for toast/OS only.
21. The pipeline runner treats a step's `run-status` with `reason:"harness-swap"` as non-terminal; the step's real settle is the swap run's terminal status.

**Nothing else is silently deferred:** every other candidate is in §9 with an in-scope task, an out-of-scope reason, or an owner decision.

---

## 9. Completeness ledger

| Item | Disposition | Task ID / reason |
| --- | --- | --- |
| Stack + member tables, `UNIQUE(harness_id)`, additive 084 | in this run | T01 |
| `harness_limit_state` account cooldown | in this run | T01/T03 |
| `harness_session_handoffs` + `runs.newestSessionForHarness` | in this run | T01 |
| `tasks.harness_state` server-managed column | in this run | T01/T02 |
| `runs.origin` extension (`harness-swap`) | in this run | T02 (column already exists) |
| Stack CRUD API + `ROUTE_POLICY` | in this run | T07 |
| `/harnesses` stacks + limit states; `/tasks` state | in this run | T07 |
| CLI/API client methods | in this run | T07/T13 |
| Stack validation (same kind/home, duplicates, unknown) | in this run | T03 |
| Stack warnings (disabled, not installed, not logged in, model, process keys, >10, hooks) | in this run | T03/T14 |
| Effective home per kind (Claude config dir, Codex `CODEX_HOME`) | in this run | T03 |
| Login evidence (claude alias `.credentials.json`, codex `auth.json`, env keys, built-in keychain = null) | in this run | T03 |
| Limit classifier (quota/429/402; 5xx/auth/network/model negatives) | in this run | T02/T06 |
| Claude usage-limit notice detection + turn preemption | in this run | T06 |
| Codex `turn.failed`/error detection | in this run | T06 |
| Fake Claude limit + transcript seam; fake Codex limit | in this run | T06/T17 |
| Account-global cooldown write/clear/expiry | in this run | T03/T08/T09 |
| Proactive cached-quota skip (automatic walks only; stale/missing fails open) | in this run | T02/T08 |
| Model-not-available / CLI-floor pre-flight skip on a backup | in this run | T08 |
| One-full-lap state machine + wrap + success reset | in this run | T02/T08 |
| All-exhausted block/countdown/retry/cap 3/10-min fallback | in this run | T08/T09 |
| Persisted swap intent + boot reconcile | in this run | T01/T08/T09 |
| Persisted retry timer + boot re-arm | in this run | T08/T09 |
| Swap settlement (old run failed, toast suppressed, task stays running) | in this run | T09 |
| New run row with new account + explicit session id + `origin` | in this run | T09 |
| Hidden tagged continuation prompt (`harness-stack-continuation`) | in this run | T02/T05/T09 |
| No-tool-call clean retry with the original prompt (`runs.hasToolUse`/`lastUserText`) | in this run | T01/T09 |
| Transfer failure blocks with a clear message | in this run | T09 |
| Spawn failure blocks with a clear message | in this run | T09 |
| Pending interaction cards cancelled | in this run | T09 |
| Background agents abandoned + status line naming them | in this run | T09 |
| Queued follow-ups kept and drained after the new run | in this run | T09 |
| Follow-up typed **during** the swap (`swapFollowUps`, bubble on the old/current run, drained in order; re-stashed on Stop) | in this run | T09 |
| Stop during the swap cancels the successor | in this run | T09 |
| Archive/delete during the swap aborts | in this run | T09 |
| Manual Run/message forces a cooling account | in this run | T08/T09 |
| Manual switch in the same stack preserves; outside resets | in this run | T09 |
| Removed/disabled member moves at the next turn + visible note | in this run | T08/T09/T15 |
| Stack delete makes the feature inert + clears task states | in this run | T03/T07 |
| Harness delete removes membership/limit/handoffs (existing task/profile guard stays) | in this run | T01/T03 |
| Claude transcript + sidecars copy; resume; cleanup | in this run | T05 |
| Codex rollout copy; stale-DB handling; cleanup | in this run | T12 |
| Codex HOME/stale-`thread_history`/MCP-OAuth spike | in this run | T00 |
| Codex HOME drop or overlay | in this run, conditional | T11 (gate T00) |
| Mirror engine (primary wins, backup-only kept, per-kind allowlist) | in this run | T04 |
| Mirror at create/update and before each swap | in this run | T04/T07/T09 |
| Never copy harness credentials | in this run | T04 (tests + review) |
| Strip harness-auth env keys | in this run | T02/T04 |
| MCP/plugin OAuth: Claude keychain shared; Codex keyring shared or file-store copy | in this run, conditional | T00/T04; DB-store deviation in §8 |
| Mirror hooks/permissions warning + safe mode | in this run | T04/T14 |
| Security review + sign-off | in this run | T04/T16 |
| Process provider-key warning | in this run | T03/T14 |
| `Task.agent` swap + profile-bound display | in this run | T09/T15 |
| Pipeline step inheritance + swap run-status ignore | in this run | T10 |
| Notifications/toasts (swap, exhausted; old run silent) | in this run | T10/T15 |
| Session copy cleanup on delete immediately, archive via the retention sweep | in this run | T09 |
| Boot re-arm/prune | in this run | T08/T09 |
| CLI `harness stack`, `ls`/`show`/`logs`, TUI | in this run | T13 |
| Settings Stacks editor + Harnesses badges | in this run | T14 |
| New Task/RunPanel/TaskCard badges + countdown | in this run | T15 |
| E2E swap + settings | in this run | T17 |
| Docs/README/architecture/topic map | in this run | T16 |
| Migration/test-hygiene/route-policy/run-events-plan/snapshot updates | in this run | T01/T07 |
| OpenCode adapter | out of scope | Grill 3; separate ticket |
| Cursor/fx/gemini/copilot/antigravity adapters | out of scope | Grill 3; each needs its own spike |
| Cross-kind fallthrough | out of scope | Grill 2 |
| Multiple stacks per account | out of scope | Grill 1 |
| Per-task opt-out | out of scope | Grill 4 |
| Bundle export of stacks | out of scope | Grill 36; machine-local, no credentials in bundles |
| Load balancing across accounts | out of scope | The requirement is failover, not spreading work |
| Topbar stack grouping | out of scope | Grill 28; one chip per account |
| Provider-key scrubbing from the process env | out of scope | Grill 37; warn only |
| Auth-failure swap | out of scope | Grill 8; the credential panel blocks |
| 5xx/529/network swap | out of scope | Grill 8; account-independent |
| Cross-account concurrency reservation | out of scope | Grill 10; no reservation in v1 |
| Windows/Linux support | out of scope | macOS-first app; the overlay is POSIX if built |
| `defaultHarness` pointing at a stack | out of scope | Implicit model: it points at an account |
| Real-binary Claude/Codex tests | out of scope | Owner accepted fake drivers; the Codex spike is the only real-binary test |
| A "return to primary when quota resets" timer | out of scope | Grill 12 chose forward+wrap, not reset-aware return |
| A "pin this task to one account" action | out of scope | No per-task opt-out; use an account outside a stack |
| A manual "cancel auto-retry" button | out of scope | A manual Run supersedes it; the cap stops after 3 |
| Encryption at rest for copied session files | out of scope | Same 0600/user-only model as the CLI's own session files; no new store |
| Syncing stacks across machines | out of scope | Machine-local; bundles don't carry credentials/homes |
| Mirroring live on a timer/file watch | out of scope | Mirror at create/update and before each swap (grill 20) |
| A new `run_events` stream for swaps | out of scope | Reuse the `status` stream (grill 25) |
| Topbar cooling chip | out of scope | Settings/RunPanel/TaskCard show it; no grouping |
| Rewriting historical `runs.agent` | out of scope | History stays honest; the handoff table is the mapping |
| Per-kind MCP OAuth DB-row copying | out of scope / owner-deferred | Only if T00 finds a DB store; §8 unratified |
| Codex HOME global change | owner-ratified in the grill, PR-body callout | T11; §8 |
| Hooks/permissions full-mirror default | owner-ratified, security-review gate | T04/T16; §8 |
| Mirror source = position 0 | assumption, §8 | T04/T14 |
| Hidden prompt tag reserved | documented | T02/T16 |
