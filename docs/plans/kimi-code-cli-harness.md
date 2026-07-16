# Plan — Kimi Code CLI as an Agetor AgentKind

| Field | Value |
| --- | --- |
| Date | 2026-07-16 |
| Source | /implement "Kimi Code / Kimi Code CLI / Kimi Code ACP; harness option in Agetor" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Mode | **Autonomous** — no owner reachable (no ask_user tool registered); both human gates self-approved; all assumptions in §8 |
| Branch | feature/kimi-code-cli-acp-support |
| Base SHA | fee2430 (clean tree) |

## 1. Objective & success criteria

Add `"kimi"` (Kimi Code CLI, Moonshot AI) as a third AgentKind, end to end: pickable in the task form once its harness is enabled in Settings, driven headlessly per turn, streaming assistant/tool events into the run panel, multi-turn via session resume, surviving agetor restarts via the standard reattach path.

Done means: `bun run typecheck` green; full `bun test` green; kimi harness row exists (disabled by default, Experimental badge); every orchestrator branch point has an explicit kimi arm (no silent codex fallthrough); driver + orchestrator + buildCommand covered by new tests using the fake-driver pattern.

## 2. Context & constraints (from investigation)

- Branch state: `AgentKind = "claude-code" | "codex"` (`src/shared/types.ts:55`). Cursor/grok exist only on unmerged sibling branches. Next migration number: **028**.
- Fleet convention (decision entry `a1a98166`): harnesses CHECK rebuild must list the **union of all in-flight kinds** — `('claude-code','codex','cursor','grok','kimi')` — with `INSERT OR IGNORE` seeds; distinct filenames per branch; second-to-merge renumbers. New kinds ship `enabled=0` + Experimental badge.
- `agents.ts` dispatch is `if claude-code {...}` then **unguarded codex fallthrough** (`buildCommand:278-452`, `spawnAgent:566-626`, `resolveBin:148-156`, `harnessEnv:164-189`) — every site must become explicit three-way or kimi mis-routes into codex.
- `orchestrator.ts` binary sites: reattach key+dispatch (`:490-521`), `startTask` onSessionId ternary (`:809-811` — would silently write kimi's id into `codexSessionId`), `sendInput` (`:1226`, fails safe), teardown arms (`:1038`, `:1893`, `:1961`, `:2010`), codex turn-queue triplet (`:1276-1420`) as the follow-up model.
- Shared driver toolkit lives in `claude-tmux.ts` (death watch, liveness, `sessionNameFor`, `killSessionByName`); `SESSION_DIED_STATUS_PREFIX` handling in `makeChunkHandler` is kind-agnostic — driver just emits the sentinel.
- Kimi CLI facts (doc-verified only, knowledge entry `f735221d`; **no local binary**): headless `--print` (implies `--afk` full auto-approve); `--output-format stream-json` = JSONL of OpenAI-chat-shaped messages (assistant text, assistant.tool_calls[], role:tool results; **no thinking on stdout**); `--input-format stream-json` reads `{"role":"user","content":...}` lines from stdin; `--session <id>` **resumes or creates** (pre-generating our own UUID is viable); exit codes 0 / 1 (permanent) / 75 (retryable); env hygiene `KIMI_CODE_NO_AUTO_UPDATE=1`, `KIMI_CLI_NO_AUTO_UPDATE=1`, `KIMI_DISABLE_TELEMETRY=1`, `NO_COLOR=1`; `--plan` = read-only tool set; `--model NAME`.

## 3. Approach & key decisions

1. **Driving surface: headless print-mode one-shot per turn, hosted in detached tmux — the codex pattern.** ACP (`kimi acp`) rejected for v1: designed for a stateful in-process IDE client, undocumented exact payload literals, and it fights agetor's detached-spawn + SQLite-replay + boot-reconcile model. The long-lived stdin-FIFO variant also rejected for v1 (unverified against a real binary; codex pattern is proven twice). Documented in §8 as revisitable.
2. **Turn shape:** `sh -c '<argv> < promptfile > runlog 2>&1; echo $? > exitfile'` inside `tmux new-session -d` (cwd via tmux `-c`). Prompt file holds one JSONL line `{"role":"user","content":"<prompt>"}`; stdin EOF ends the turn. **Exit-code sidecar** (cursor-branch lesson) distinguishes clean failure from session-died: session gone + exitfile → status by code (0 → succeeded; 1/other → failed; 75 → failed with "retryable" noted in the status event); session gone without exitfile → `SESSION_DIED_STATUS_PREFIX` sentinel.
3. **argv:** `kimi --print --output-format stream-json --input-format stream-json --session <uuid> [--model <id>] [--plan when mode!=auto] [AGETOR_KIMI_ARGS...]`. Mode map: `auto` (default) → nothing extra (print already fully auto-approves); `ask` → `--plan` (read-only tools). No `--work-dir` (tmux `-c` owns cwd — fewer unverified flags).
4. **Session continuity:** pre-generate `crypto.randomUUID()` at first spawn, report via `onSessionId` immediately, persist as `runs.kimi_session_id`; follow-up turns pass the same `--session <id>`. No output parsing needed for the id.
5. **Event mapping (`mapKimiEvent`):** role:assistant content → `assistant` chunk; assistant.tool_calls[] → `tool_use` (one per call, keyed by tool_call id); role:tool → `tool_result` (matched by tool_call_id); role:user → skip (prompt echo). Thinking absent from stdout by design — v1 accepts no thinking stream (follow-up: tail `wire.jsonl`). Dedupe key `line_uuid = "kimi:<lineNo>"` (log is append-only; replay from offset 0 on reattach is stable).
6. **Effort:** kimi gets `efforts: []` / all-models-decline in `MODEL_EFFORT_SUPPORT` (kimi-cli only has boolean `--thinking`; no flag passed v1). Curated models: `kimi-k2.7-code` (default), `kimi-k2.6`, `kimi-k2.5` — unknown ids pass through verbatim per house rule.
7. **Env:** `harnessEnv` kimi arm sets `HOME` + `KIMI_CODE_HOME` when `harness.home` set; `buildCommand` injects the four hygiene vars **before** the harness-env merge so user overrides win (grok privacy-pass pattern). Overrides: `AGETOR_KIMI_BIN` / `AGETOR_KIMI_ARGS` / `AGETOR_KIMI_DRIVER=fake`.
8. **Ships disabled by default** (`enabled=0` seed) + Experimental badge — no local binary existed to smoke-test; the mapper is doc-verified only.

### Driver export contract (T2 owns the file; T4 codes against this, exactly mirroring codex-tmux.ts)

```ts
// src/bun/kimi-tmux.ts
export function kimiLogPath(runId: string): string
export function mapKimiEvent(line: string, onChunk: ChunkHandler, lineNo: number): void  // pure, unit-testable
export function spawnKimiViaTmux(opts: { taskId; runId; argv; env; cwd; promptText; onChunk; onSessionId }): SpawnedAgent
export function reattachKimiSession(opts: /* mirror reattachCodexSession */): SpawnedAgent | null
export function kimiSessionActive(taskId: string): boolean
export function dropKimiSession(taskId: string): void
```

## 4. Work breakdown — implementation tasks

**T1 — types, persistence, mechanical exhaustiveness (wave 1).** Files: `src/shared/types.ts`, `src/bun/migrations/028_kimi_harness.sql` (NEW), `029_kimi_session_id.sql` (NEW), `migrations/index.ts`, `src/bun/db.ts`, `src/bun/server.ts` (POST /harnesses whitelist ~:2635), `src/bun/agent-status.ts` (INSTALL_HINTS: `npm i -g @moonshot-ai/kimi-code` note both installs), `src/bun/agent-discovery.ts` (static curated list), `src/bun/orchestrator.ts` (**only** `kimiSessionId: null` literals — no logic), the 13 test files with Run literals (mechanical field add), `src/mainview/AgentIcon.tsx` (Kimi glyph from @lobehub/icons if it exists, else generic fallback), `NewTaskForm.tsx` (agentCache entry only), `App.tsx` (AgentModelMap init), `api.ts` (types). Acceptance: `bun run typecheck` green with zero behavior change for existing kinds; migration follows the union-CHECK + INSERT-OR-IGNORE convention, kimi seeded disabled.

**T2 — kimi-tmux driver (wave 1).** Files: `src/bun/kimi-tmux.ts` (NEW only). Implements §3 items 2–5 + contract above; imports shared primitives from `claude-tmux.ts`; death watch always-in-flight (one-shot); emits `SESSION_DIED_STATUS_PREFIX` sentinel. Acceptance: file typechecks standalone; behavior mirrors codex-tmux flow with exit-code sidecar.

**T3 — agents.ts wiring (wave 2).** Files: `src/bun/agents.ts` only. Explicit kimi arms in `resolveBin`, `harnessEnv`, `buildCommand` (argv per §3.3, env per §3.7), `spawnAgent` (fake-driver hook `AGETOR_KIMI_DRIVER=fake` mirroring codex's, then `spawnKimiViaTmux`); convert the codex fallthroughs it touches into explicit `kind === "codex"` guards with an exhaustive `never` throw at the end. Acceptance: no path routes kimi into codex code; claude/codex argv unchanged (existing tests stay green).

**T4 — orchestrator logic (wave 2).** Files: `src/bun/orchestrator.ts` only. Reattach key + dispatch third arm; `startTask` session-id ternary → explicit per-kind field; `sendInput` kimi branch + `sendKimiTurn`/`kimiTurnQueue`/`drainKimiQueue`/`spawnKimiFollowupTurn` (mirror the codex triplet); teardown arms at `:1038/:1893/:1961/:2010` → `dropKimiSession`; reconcileOrphans `canTryReattach` widened to kimi. Acceptance: every `kind === "claude-code" ? … : codex` site has an explicit kimi arm; orphan/reattach semantics match codex's (reattach only while a turn is in flight).

**T5 — UI + CLI + docs (wave 2).** Files: `src/mainview/SettingsDialog.tsx` (kind-picker array literal ~:750, experimental badge → include kimi, home-override copy third arm), `RunPanel.tsx` + `DiffDialog.tsx` (resumableRunId: widen to `kind === "claude-code" || kind === "kimi"` — kimi has real resume), `rebuilt-mask.ts` (third arm if session-id branch exists), `src/cli/commands/harness.ts` (login hint: `kimi login`), `src/cli/api-client.ts` (stale comment), `CLAUDE.md` (agent command shape section), `README.md` (mention). Acceptance: kimi harness can be enabled and edited in Settings; no claude/codex UI regressions.

## 5. Work breakdown — test tasks (phase 6)

**T6 — `src/bun/kimi-tmux.test.ts`** (NEW): mapKimiEvent unit tests — assistant text, tool_calls → tool_use, role:tool → tool_result matched by id, user-echo skipped, malformed line tolerated, line_uuid stability; exit-code sidecar → status mapping incl. 75.
**T7 — `src/bun/orchestrator-kimi.test.ts`** (NEW): fake-driver end-to-end (AGETOR_DATA_DIR mkdtemp before db import, `AGETOR_KIMI_DRIVER=fake`, `AGETOR_KIMI_BIN=/bin/echo`): startTask happy path, session-id persisted to `kimi_session_id` (not codex's), follow-up turn queue, teardown on delete, reconcile orphans (report-gone fake tmux — hermeticity trap from grok entry `8dff1f8f`).
**T8 — `src/bun/agents-kimi.test.ts`** (NEW) + `src/bun/harnesses.test.ts` (extend): buildCommand argv shaping (modes, model, AGETOR_KIMI_ARGS, hygiene env + user override wins), resolveBin/harnessEnv arms, and the previously-missing "permitted by CHECK, rejected by app layer" harness test.

## 6. Execution waves

- **Wave 1:** T1 ∥ T2 (disjoint: T2 owns only the new driver file).
- **Wave 2:** T3 ∥ T4 ∥ T5 (disjoint: agents.ts / orchestrator.ts / UI+CLI+docs). T4 imports T2's contract (landed in wave 1).
- Checkpoint after each wave: `bun run typecheck`, commit.
- **Phase 5** review (opus) → **Phase 6:** T6 ∥ T7 ∥ T8 (all-new disjoint files + harnesses.test.ts owned by T8 alone) → **Phase 7** full `bun test` → **Phase 8** fix loop (≤3 rounds).

## 7. Blast radius & risks

- Existing claude/codex paths: touched only by adding explicit guards — covered by the existing 1,000+ test suite.
- Migration is a table rebuild — union CHECK per fleet convention keeps it order-independent vs unmerged cursor/grok branches; **merge-time note:** if cursor/grok land first, renumber 028/029 and re-append in index.ts.
- `resolveBin`/`harnessEnv` codex fallthroughs becoming explicit could break an unknown-kind edge case — the `never` throw makes that loud at compile time instead of silent at runtime.
- Mapper is doc-verified only; wrong field literals would show as empty run panels, not crashes. Mitigated by disabled-by-default + Experimental.

## 8. Open questions / assumptions (autonomous mode — both gates self-approved)

1. **ACP not used for driving** despite the branch name; "Kimi Code ACP" treated as one of the product's names. Print-mode one-shot chosen (rationale §3.1). Revisit if mid-turn permission negotiation is ever wanted.
2. **Target CLI surface = documented kimi-cli (Python) flags**, assumed forward-compatible with kimi-code (TS successor, same binary name, advertised config/session auto-migration).
3. Curated model list (`kimi-k2.7-code` default, k2.6, k2.5) is web-corroborated, not Moonshot-doc-confirmed; passthrough covers drift.
4. No effort mapping v1 (boolean `--thinking` deferred; default thinking behavior left to the CLI).
5. Thinking stream absent v1 (stdout stream-json excludes it); follow-up: tail `wire.jsonl` for ThinkPart parity.
6. Exit 75 treated as `failed` (retryable noted in the status event), no auto-retry v1.
7. Ships disabled; **live-binary smoke test required before enabling by default** (exact stream-json field literals + "--print never blocks on TTY" unconfirmed).
8. No kimi slash-command/config discovery in `commands.ts` v1.
9. Long-lived stdin-FIFO multi-turn process (supported by `--input-format stream-json`) deferred in favor of proven one-shot-per-turn.
