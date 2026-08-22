# Plan — Vercel fx (fx.sh) as a new AgentKind, driven over ACP

| Field | Value |
| --- | --- |
| Date | 2026-08-20 |
| Source | /implement "Vercel fx.sh as a new harness" + owner grill answers |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/vercel-fx-sh-as-a-new-harness |
| Base SHA | 8a7e4b066f7eeb89856365acd86704a396ad4b8d (== origin/main; tree clean) |

> **Superseded in part** by `docs/plans/fx-acp-interactions.md` (permission cards, plan→TODO mapping, usage chip) and `docs/plans/fx-branch-finalization.md` (correctness fixes, driver refactor, docs truth, CLI answer path). This document is kept as the original design record — sections below carry inline `(superseded — see …)` notes where a later plan changed the decision; the rest still describes the shipped v1 accurately.

## 1. Objective & success criteria

Add `fx` — Vercel Labs' coding agent (https://fx.sh, native binary, v0.0.4, experimental) — as agetor's fifth `AgentKind`, driven through its **ACP server** (`fx acp`, Agent Client Protocol: newline-delimited JSON-RPC 2.0 over stdio) for **live streaming** of assistant text, thinking, and tool events.

Done means: an fx task can be created (harness ships **disabled by default**, experimental badge), started, streamed live in the RunPanel, sent follow-up turns (session continuity via ACP session id), stopped mid-turn, and deleted — with `bun run typecheck` and `bun test` green, fresh-DB migration replay 001..046 correct, and Playwright e2e unaffected.

## 2. Context & constraints (grounded findings)

**fx contract — spike-verified against the real v0.0.4 binary (macOS arm64), no auth:**
- No streaming print mode exists: `fx ask --json` returns ONE buffered object at exit; `--stream-json` rejected. **ACP is fx's only streaming surface** (owner explicitly chose it over one-shot `fx ask`).
- `fx acp [--model <id>] [--log-file <path>]` — `--model` accepted at spawn (spike probe 7); "overrides the model for the server process, including loaded sessions" (fx.sh/docs/using-fx/acp.md). `--log-file` is the only diagnostics channel — stdout is protocol-only.
- Wire framing **verified live**: one JSON object per line; `initialize` answered in ~30ms; `protocolVersion` must be **numeric** (string → `-32602 Invalid initialize params`).
- **Auth gates at `initialize`**: unauthenticated → `{"code":-32600,"message":"Fx needs access to Vercel AI Gateway. Run fx login … or set AI_GATEWAY_API_KEY."}` and the server latches into permanent "Not initialized" rejection of every later method. Process stays alive; the client must kill it.
- Permission modes (via `fx permissions --help`, spike): `ask` / `auto` (default) / `yolo` ("disable permissions and sandboxing"). `FX_PERMISSION_MODE` env var exists in binary strings; bogus values silently ignored; **its effect on the acp server is unverified without auth** (see §8).
- No `FX_HOME`/`FX_CONFIG_DIR` (strings-grep zero hits): state hardcoded under `~/.fx/*` → per-harness isolation = **full `HOME` override** (cursor's pattern). fx writes nothing to `$HOME` until authenticated (spike probe 8).
- Auth for the user: `fx login` (OAuth) or `AI_GATEWAY_API_KEY`. Install: `curl -fsSL https://fx.sh/setup.sh | bash`. No Windows build. Interrupt exit code 130.

**ACP protocol — from the canonical schema.json + agentclientprotocol.com v1 docs:**
- Minimal text-only client = `initialize` → `session/new {cwd, mcpServers:[]}` → `session/prompt {sessionId, prompt:[{type:"text",text}]}`, consuming `session/update` notifications and answering `session/request_permission` requests. Prompt response arrives only at turn end with `stopReason ∈ {end_turn, max_tokens, max_turn_requests, refusal, cancelled}`.
- `session/update` variants we render: `agent_message_chunk` → assistant, `agent_thought_chunk` → thinking, `tool_call` → tool_use (fields `toolCallId`, `title`, `kind`, `status ∈ pending|in_progress|completed|failed`, `rawInput`), `tool_call_update` → tool_result on terminal status (patch semantics, only `toolCallId` required). Other variants (`plan`, `usage_update`, `current_mode_update`, …) tolerated and ignored in v1 *(superseded — see fx-acp-interactions.md §3.4–3.5: `plan` and `usage_update` are no longer ignored, `current_mode_update` still is)*.
- `session/request_permission` → client answers `{"outcome":{"outcome":"selected","optionId":…}}` picking by option `kind` (`allow_once|allow_always|reject_once|reject_always`), or `{"outcome":"cancelled"}` after `session/cancel`.
- `session/cancel` is a notification; the pending prompt then resolves `stopReason:"cancelled"`.
- fx extras: `session/resume` ("reconnect to a saved session **without replaying history**" — ideal for follow-up turns), `session/load` (replays full history as `session/update`s before the response), `session/close`; **one active session per connection**; 8 MiB per inbound message; ACP modes advertised by fx are `ask`/`code` only.
- Client capabilities all default false; with `fs`/`terminal` unadvertised the agent must not call those client RPCs (fx has its own internal tools).

**Codebase recipe (mapped by touch-point agent; gemini = closest template, PR #153 needed zero correctness follow-ups):**
- Compile-forced sites: `AgentKind` union + 8 `Record<AgentKind,…>` maps in `src/shared/types.ts`, `INSTALL_HINTS`, `AgentModelMap` + 2 state literals, `AgentIcon` ICONS record.
- **Silent-fallthrough sites needing manual sweep** (typecheck will NOT catch): `orchestrator.ts` dispatch chains (reattach ternary's final else is gemini-shaped!), `db.ts` kind whitelists, `server.ts` POST /harnesses validation + `/agent-models` GET+POST literals, `SettingsDialog` `isExperimentalKind` + harness-type radio + **`grid-cols-4`→`grid-cols-5` CSS trap**.
- `agents.ts`: codex block is the **unconditional trailing fallthrough** — the fx block must be inserted as a guarded `if` BEFORE it. Fake driver = `AGETOR_FX_DRIVER=fake` gate reusing `makeFakeAgent`.
- Migrations: next free numbers **045/046**. Harness CHECK rebuild must list the union of every kind any migration ever seeded plus in-flight siblings (`claude-code, codex, cursor, grok, gemini, kimi, fx`), explicit column-list copy (never `SELECT *`), seed `enabled=0`, trailing `INSERT OR IGNORE` self-heal (a wrong rebuild once wiped a prod harnesses table — fleet-documented incident).
- `fxSessionId: null` mechanical sweep across ~23 test files + `orchestrator.ts` (do scripted, not by hand).

## 3. Approach & key decisions

1. **ACP client driver, no tmux** *(owner decision)*. New `src/bun/fx-acp.ts`: per-turn `Bun.spawn(["fx","acp","--model",<id>,"--log-file",<dataDir>/fx-logs/<runId>.log], {cwd, env})` with piped stdio; hand-rolled minimal client (5 message shapes — no `@agentclientprotocol/sdk` dependency, version unverifiable and surface tiny). Sequence: `initialize` (protocolVersion **1**, all capabilities false, clientInfo agetor) → `session/new` (first turn) / `session/resume` → fallback `session/load` (follow-ups) → `session/prompt` → stream updates → resolve on prompt response `stopReason`.
   - *Trade-off accepted*: stdio pipes can't be reattached — a mid-turn agetor restart orphans the fx run (boot reconciliation flips it `orphaned` → task `ready`, the existing generic path; fx is simply excluded from `canTryReattach`). The kimi branch rejected ACP for exactly this; fx has no alternative streaming surface, and the owner chose streaming.
   - *Per-turn process (not per-task)*: matches "one active session per connection", gives per-turn `--model`, makes death handling = process-exit handling, keeps memory bounded. Continuity lives in the persisted ACP `sessionId` (`runs.fx_session_id`, discovered from `session/new`'s result — codex-thread-id pattern).
   - *Resume*: try fx's `session/resume {sessionId}` (no replay); on method-not-found/param error fall back to `session/load` and **discard all `session/update`s until the load response arrives** (replayed history is already in `run_events`).
2. **Three modes** *(owner decision)*: `yolo` → `FX_PERMISSION_MODE=yolo`, `auto` → `FX_PERMISSION_MODE=auto`, `ask` → `FX_PERMISSION_MODE=ask`. Enforcement backstop that works even if the env var is inert over ACP: the client's `session/request_permission` policy — `ask` → pick `reject_once`; `yolo`/`auto` → pick `allow_always`/`allow_once`. Best-effort `session/set_mode` (`auto`→`code`, `ask`→`ask`) when `session/new` advertises modes. Null `task.mode` → global default `auto` (existing behavior). *(superseded — see fx-acp-interactions.md §3.2: this auto-answer policy is now `yolo`-only; `ask` **and** `auto` instead register an interactive permission card and await the user's answer.)*
3. **Models** *(owner decision)*: starter list in `AGENT_OPTIONS.fx` — `zai/glm-5.2-fast` (default, "GLM 5.2 Fast — fx default"), `openai/gpt-5.5`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `google/gemini-3-pro`; unknown ids pass through verbatim via `--model`. No effort knob (`MODEL_EFFORT_SUPPORT.fx` all `[]`).
4. **Event mapping** (schema-grounded; live stream unverifiable without credentials — render defensively, generic payload rendering like cursor): `agent_message_chunk`→assistant, `agent_thought_chunk`→thinking, `tool_call`→tool_use (`title`+`kind`, `rawInput` generic), `tool_call_update` with terminal `status`→tool_result; `line_uuid`: `fx:<runId>:<seq>` monotonic (tool events `fx:tool:<toolCallId>:<use|result>`). `stopReason`: `end_turn`→ok; `cancelled`→cancelled; `refusal`/`max_tokens`/`max_turn_requests`→failed with a status line; initialize auth error → failed with fx's own message text (it's user-actionable). Init/session timeouts (30s, `RPC_HANDSHAKE_TIMEOUT_MS`) so a wedged spawn can't hang a turn; unexpected process exit mid-turn → settle failed with `SESSION_DIED_STATUS_PREFIX` status (existing `blocked`/`session-died` orchestrator path).
5. **Ships disabled** (house convention): migration seeds `enabled=0`; `isExperimentalKind` badge; no server rejects (opt-in via Settings toggle like codex/cursor/gemini).
6. **Non-goals v1** *(owner decision)*: no usage provider, no plan detection, no slash-command/MCP discovery (`builtinCommands` falls through to `[]`), no effort, no e2e spec (no bespoke UI), no ACP-permission-request UI surfacing (auto-answered per mode), no live authenticated verification. *(superseded — see fx-acp-interactions.md: usage now renders as a run-row chip, `plan` now feeds the TODO tracker, and permission requests now surface an interactive card in ask/auto mode. "No live authenticated verification" and "no e2e spec" remain true as of fx-harness.md's own scope; fx-branch-finalization.md adds the first e2e coverage for any interaction card.)*

## 4. Work breakdown — implementation tasks

**Wave 1** (parallel, disjoint):
- **T1 types** — owns `src/shared/types.ts`: `AgentKind` + `fx` entries in `HARNESS_TEMPLATES` (`fx-additional`), `DEFAULT_MODEL` (`zai/glm-5.2-fast`), `DEFAULT_EFFORT` (symmetry value), `CODE_PLAN_MODE` (`{code:"yolo", plan:"ask"}`), `MODEL_EFFORT_SUPPORT` (all `[]`), `MODEL_MODE_DENY` (`{}`), `AGENT_OPTIONS` (5 models, 3 modes yolo/auto/ask with labels+hints), `Run.fxSessionId` + doc comment, `Harness.home` doc paragraph (HOME-override isolation).
- **T2 migrations** — owns `src/bun/migrations/`: `045_fx_harness.sql` (rebuild with CHECK `('claude-code','codex','cursor','grok','gemini','kimi','fx')`, explicit column copy, seed fx `enabled=0`, trailing `INSERT OR IGNORE` self-heal for all builtins), `046_fx_session_id.sql` (`ALTER TABLE runs ADD COLUMN fx_session_id TEXT;`), register both in `index.ts` (append-only).
- **T3 driver** — owns new `src/bun/fx-acp.ts`: ACP client (framing, id counter, request/notification dispatch, timeouts), spawn/session lifecycle per §3.1, permission policy per §3.2, event mapper per §3.4, `fxSessionActive`, `dropFxSession` (kill process + dispose), cancel via `session/cancel` then SIGTERM grace. Exports mirror the other drivers' surface so wave-3 wiring is mechanical.

**Wave 2** (parallel, disjoint; after wave 1 commit):
- **T4 dispatch** — owns `src/bun/agents.ts` + `src/bun/agent-status.ts`: `resolveBin` (`fx`, `AGETOR_FX_BIN`/`_ARGS`), `harnessEnv` (`HOME` override when `harness.home` set), `buildCommand` fx block **before** the codex fallthrough (argv `["fx","acp","--model",…,"--log-file",…]` + `FX_PERMISSION_MODE` env; prompt NOT in argv — delivered over JSON-RPC), `spawnAgent` fx branch with `AGETOR_FX_DRIVER=fake` gate (`makeFakeAgent`, discovered-session-id timing), `INSTALL_HINTS.fx` (curl installer one-liner).
- **T5 db** — owns `src/bun/db.ts`: `harnesses.getByIdOrKind` + label, `harnesses.insert` whitelist, `RunRow`/`toRun`/`runs.insert`/`runs.update` `fx_session_id` (4 sites).
- **T6 server** — owns `src/bun/server.ts`: POST `/harnesses` kind validation + error string; `/agent-models` GET and POST literals gain `fx`.
- **T7 UI** — owns `src/mainview/**`: `AgentIcon` (verify `@lobehub/icons` Vercel/fx glyph, else `Vercel` mark or fallback), `NewTaskForm` `seed("fx")`, `SettingsDialog` (`isExperimentalKind`, `HARNESS_HOME_COPY.fx`, radio array + `grid-cols-5`), `lib/api.ts` `AgentModelMap.fx`, `App.tsx` + `ResolveConflictsDialog` literals, `OnboardingChecklist` `LOGIN_COMMAND.fx = "fx login"`.

**Wave 3** (parallel, disjoint; after wave 2 commit):
- **T8 orchestrator** — owns `src/bun/orchestrator.ts`: `reconcileOrphans` (add `fx_session_id` to the SQL + reattachKey; **exclude fx from `canTryReattach`** so its runs orphan cleanly), `startTask` session-null + `onSessionId` arm, `sendInput` dispatch, the `fxTurnQueue`/`sendFxTurn`/`spawnFxTurnNow`/`drainFxQueue`/`findLastFxSessionId` quintuple, both `drain*Queue` call-site pairs, agent-switch + archive + delete teardown chains + 3 turn-queue-clear triplets.
- **T9 test sweep + fixtures** — owns the ~23 test files with `<kind>SessionId: null` literals (scripted append of `fxSessionId: null`) and `e2e/fixtures.ts` (add `AGETOR_FX_DRIVER: "fake"` beside the existing fake-driver env).
- **T10 docs** — owns `CLAUDE.md`: fx driver paragraph (house style, mirrors gemini's), env-override list gains `AGETOR_FX_BIN`/`_ARGS`/`AGETOR_FX_DRIVER`.

## 5. Work breakdown — test tasks

- **TT1** — new `src/bun/fx-acp.test.ts`: unit-test the mapper (schema-shaped `session/update` fixtures → chunks; stopReason mapping; auth-error mapping) and the client against a **scripted fake ACP server** (a bun stub script installed via `AGETOR_FX_BIN` speaking real newline-JSON-RPC: handshake, streamed turn, permission request in each mode, cancel, resume-then-load fallback, mid-turn exit).
- **TT2** — new `src/bun/orchestrator-fx.test.ts` (fake driver): startTask → events → review; follow-up turn resumes with persisted `fxSessionId`; busy-queue; cancel; delete teardown; boot reconcile flips running fx run to orphaned.
- **TT3** — `src/bun/agents.test.ts` fx describe block: buildCommand argv/env per mode+model, resolveBin override, harnessEnv HOME override, fake gate. Also extend `harnesses.test.ts`/`migrate.test.ts` if their kind-list assertions are order/kind-sensitive (touch-point brief flags one order-sensitive test).
- **E2e**: applicable flows are covered by existing generic board specs; **no new e2e spec** — fx adds no bespoke UI. Recorded decision, not an omission. Run recipe (for Phase 7): `bun run typecheck`; `bun test`; `bunx playwright test` (auto-manages Vite + per-worker headless backends; no credentials needed — fake drivers).

## 6. Execution waves

W1 {T1,T2,T3} → commit → W2 {T4,T5,T6,T7} → commit → W3 {T8,T9,T10} → commit → review (Phase 5) → W4 {TT1,TT2,TT3} → commit → test run → fixes.

## 7. Blast radius & risks

- **Migration 045 rebuilds the harnesses table** — the one genuinely dangerous change (prior prod wipe incident). Mitigations baked in: union CHECK, explicit columns, self-heal reseed, migrate.test.ts replay assertions; dogfood only against `~/.agetor-dev`.
- **Mid-turn restart orphans fx runs** (no reattach). Surfaced as designed behavior; routine restarts between turns unaffected (session id persists).
- Live ACP stream shapes unverified without credentials → mapper is schema-derived; defensive/generic rendering; harness ships disabled until someone live-verifies.
- `FX_PERMISSION_MODE` efficacy over ACP unverified → permission-response policy is the real enforcement; worst case `yolo` behaves like `auto` (sandbox on) until live-verified — safe direction.
- fx is v0.0.4 "experimental" — flags may churn; all ids pass through verbatim, so catalog updates are 2-touch-point changes like gemini's.
- Rollback: revert commits; migrations are additive (a column + a rebuild that preserves all rows) — old builds ignore the extra column and the fx row's kind is invisible to their pickers, though their `INSERT` whitelist won't accept new fx harnesses (fine).

## 8. Open questions / assumptions

- **A1** (assumption, low risk): `FX_PERMISSION_MODE` is honored by `fx acp`. Backstopped by the client permission policy; flagged for live verification.
- **A2** (assumption, medium): fx's `session/resume` params are `{sessionId}` per the base schema's `ResumeSessionRequest`. Fallback to `session/load`+discard is implemented regardless, so wrongness costs nothing.
- **A3** (assumption, low): `@lobehub/icons` has a usable Vercel/fx glyph; else a neutral fallback icon ships (visual-only).
- **Deferred to owner post-merge**: live authenticated smoke turn (`fx login` on your machine, enable the harness in Settings) before enabling by default; ACP permission-request UI surfacing and `plan`/`usage_update` rendering as future enhancements. *(superseded — see fx-acp-interactions.md: permission-request UI surfacing and `plan`/`usage_update` rendering both shipped. The live authenticated smoke turn remains genuinely deferred — still unverified without credentials, per fx-harness.md §8 A1/A2 and fx-branch-finalization.md §8 A1/A2.)*

## 9. Completeness ledger

n/a — `--no-follow-ups` not active.
