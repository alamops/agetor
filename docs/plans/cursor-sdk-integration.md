# Plan — Cursor agent integration (third agent kind: `cursor`)

| Field | Value |
| --- | --- |
| Date | 2026-07-10 |
| Source | `/implement Cursor SDK into Agetor` (agetor task, autonomous run) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/2bf84bdd9a0d-cursor-sdk-integration |
| Base SHA | 55ef208778e3059ef74c07547607bdca8cb3f015 |
| Mode | **Autonomous** — the grill and plan-approval gates were bypassed (no owner reachable; `ask_user` not registered). Every assumption is logged in §8. |

## 1. Objective & success criteria

Add **Cursor** as a third agent kind alongside `claude-code` and `codex`, driven through the `cursor-agent` CLI in headless print mode, with full parity with codex's session model: one-shot turn per invocation hosted in a detached tmux session, NDJSON event stream mapped to agetor's unified `assistant`/`thinking`/`tool_use`/`tool_result` streams, multi-turn continuity via `--resume <session_id>`, boot reattach, death-watch, and the disabled-by-default opt-in rollout.

Done means: typecheck green, full `bun test` green, cursor selectable in the New Task picker once enabled in Settings, fake-driver e2e test proves createTask→startTask→sendInput→resume flow, and CLAUDE.md/README document the new kind.

## 2. Context & constraints (grounded findings)

**Cursor CLI contract (verified against docs.cursor.com, 2026-07-10):**
- Binary `cursor-agent` (alias `agent`), install `curl https://cursor.com/install -fsS | bash`, auth via `agent login` or `CURSOR_API_KEY`.
- Headless: `cursor-agent -p --output-format stream-json [--force] [--model <id>] [--resume <chatId>] "<prompt>"`. Tool calls are **disabled by default** in `-p` mode; `--force` enables auto-execution.
- Stream-json NDJSON events: `system/init` (carries `session_id`, on every event thereafter), `user`, `assistant` (full message content), `tool_call` (`subtype: started|completed`, correlated by `call_id`), terminal `result` (`subtype: success|…`, `is_error`, full `result` text). On failure the stream may end **without** a `result` event — non-zero exit is the only signal.
- We do **not** pass `--stream-partial-output` — its assistant deltas arrive in ≥4 undocumented shapes and double-count text. Message-level granularity matches codex UX.
- Only the `tool_call` envelope (`type`, `call_id`, `subtype`) is a stable contract; inner `args`/`result` shapes are explicitly unstable — render them generically.
- Resume: capture `session_id` from any event on turn 1; `--resume <id>` on later turns. No live process between turns (identical to codex thread model).
- `--sandbox <enabled|disabled>` exists; no effort/reasoning flag exists.
- `cursor-agent` is **not installed** on this machine — all runtime paths must be testable via the `/bin/echo` + fake-driver conventions.

**Codebase map (anchors from investigation, HEAD 55ef208):**
- `AgentKind` union at `src/shared/types.ts:55` pivots ~10 `Record<AgentKind,…>` maps (`HARNESS_TEMPLATES` :146, `DEFAULT_MODEL` :390, `DEFAULT_EFFORT` :396, `CODE_PLAN_MODE` :421, `MODEL_EFFORT_SUPPORT` :466, `MODEL_MODE_DENY` :521, `AGENT_OPTIONS` :544) — the compiler enforces exhaustiveness once the union grows.
- `agents.ts`: `resolveBin` :120 and `harnessEnv` :136 are **binary ternaries that break for a 3rd kind** (a cursor harness would silently get `CODEX_HOME`); `buildCommand` :250, `buildCodexCommand` :418 (the `gitWritableRootsSync` seam), fake drivers :436, `spawnAgent` :523.
- `codex-tmux.ts` is the driver template: `spawnCodexViaTmux`/`reattachCodexSession`/`dropCodexSession`/`mapCodexEvent`/`codexLogPath`; shares death-watch primitives imported from `claude-tmux.ts`; prompt via file redirect (injection safety); `SpawnedAgent = { kill, writeInput: () => false, done }`.
- `orchestrator.ts` kind-dispatch points: `reconcileOrphans` :416-447, `startTask` onSessionId :711, `makeChunkHandler` :757 (claude-only apiError; session-died sentinel is kind-agnostic), `reconcileTaskSession` :940, `sendInput` :1119 (falls to "unknown agent kind" today), `spawnCodexTurnNow`/`drainCodexQueue`/`findLastCodexSessionId` :1181-1281, `archiveTask` :1697, `deleteTask` :1738.
- DB: `harnesses.kind` CHECK in `013_harnesses.sql` requires a **table-rebuild migration** to widen (SQLite). `021_codex_session_id.sql` is the session-id column precedent. Migrations end at 023. `db.ts` hardcodes kinds in `getByIdOrKind` :359 and `harnesses.insert` :382, plus run-row mapping :484-531.
- Server: `POST /harnesses` kind validator `server.ts:606`, `/agent-models` literals :857-876.
- UI: `AgentIcon.tsx` `ICONS` record :8; `NewTaskForm.tsx` agentCache/seed :168-209, plan-tooltip :582; `SettingsDialog.tsx` type-radio hardcodes two kinds :747 (+ grid-cols-2), home-hint ternary :772.
- `commands.ts` `builtinCommands` :152 is a binary ternary (codex needed a follow-up fix here — pitfall #6).
- Tests: temp `AGETOR_DATA_DIR` before importing db.ts; `AGETOR_CURSOR_DRIVER=fake` + `AGETOR_CURSOR_BIN=/bin/echo` conventions; `harnesses.setEnabled` needed in tests when kind ships disabled.

**House rollout style (codex precedent):** new kinds ship **disabled by default** (migration flips/seeds `enabled=0`), surfaced in Settings behind an opt-in toggle with an "experimental" badge — but *without* the hard "coming soon" server rejects/UI locks codex once had.

## 3. Approach & key decisions

1. **CLI, not `@cursor/sdk` (npm).** *Decision.* The npm SDK runs inside agetor's Bun main process: a mid-turn app restart kills the run, breaking agetor's reattach-on-boot guarantee; it requires Node ≥22.13 with per-platform native binaries (Bun compat unverified); and it has no tmux-survival story. The CLI (`cursor-agent -p`) maps 1:1 onto the proven codex driver: one-shot turn inside a detached tmux session, output redirected to a per-run log, tailed and mapped. Revisit the SDK only if the CLI proves unreliable.
2. **Clone `codex-tmux.ts` → `cursor-tmux.ts`; do not refactor a shared "one-shot driver" abstraction now.** *Decision.* Generalizing would touch working codex paths with no owner present to approve the risk. The duplication (~500 lines) is noted as follow-up work in §8.
3. **Third nullable column `runs.cursor_session_id`** (mirrors migration 021), not a generic `session_id` refactor. Mechanical, matches precedent, keeps the diff reviewable. The "exactly one non-null per run" convention extends to three columns.
4. **Mode mapping:** `auto` → `-p --output-format stream-json --force --sandbox disabled` (agetor's no-sandbox philosophy, same spirit as claude's `--dangerously-skip-permissions` and codex's `danger-full-access` escalation — and it sidesteps the worktree external-`.git` sandbox bug codex hit); `ask`/plan → same argv **without** `--force` and without `--sandbox disabled` (propose-only; cursor cannot execute unapproved actions headlessly). No `gitWritableRootsSync` escalation logic is needed because auto never runs sandboxed.
5. **Models (curated, passthrough for unknowns):** `auto` (default), `composer-2.5`, `claude-sonnet-5`, `claude-opus-4.8`, `gpt-5.5`. No effort knob (`MODEL_EFFORT_SUPPORT.cursor` = all empty arrays).
6. **line_uuid scheme:** `tool_call:<call_id>:<subtype>` where a `call_id` exists; otherwise `cursor:<lineIndex>` (0-based index of the NDJSON line in the per-run log). Replay-from-offset-0 on reattach regenerates identical keys → idempotent against the `(run_id, line_uuid)` unique index.
7. **Prompt delivery:** stdin support is unverified, so the prompt is passed as a positional argv element — **never interpolated into the `sh -c` string**. Use the `sh -c 'exec "$0" "$@" > <log> 2>&1' <argv...>` pattern (argv stays out of shell parsing) or `"$(cat <promptfile>)"` — implementer picks whichever survives a manual quoting test; the injection-safety requirement is non-negotiable.
8. **Rollout:** built-in `cursor` harness row seeded with `enabled=0` in the same rebuild migration; Settings shows it with the existing experimental badge treatment; no server rejects.

## 4. Work breakdown — implementation tasks

**Wave 1** (foundations; disjoint files):
- **T1 — shared types.** Owns `src/shared/types.ts`. Add `"cursor"` to `AgentKind`; extend `HARNESS_TEMPLATES` (cursor-additional, HOME-override semantics), `DEFAULT_MODEL` (`auto`), `DEFAULT_EFFORT` (no-effort sentinel, mirror haiku), `CODE_PLAN_MODE` (plan→`ask`-style propose-only id), `MODEL_EFFORT_SUPPORT` (empty arrays), `MODEL_MODE_DENY` (`{}`), `AGENT_OPTIONS` (models per §3.5, modes auto/ask). Acceptance: typecheck reveals every downstream `Record<AgentKind,…>` gap (fixed by later tasks).
- **T2 — migrations + db.ts.** Owns `src/bun/migrations/*` and `src/bun/db.ts`. `024_cursor_harness.sql`: rebuild `harnesses` with CHECK widened to three kinds, copy rows, seed built-in cursor row `enabled=0`. `025_cursor_session_id.sql`: `ALTER TABLE runs ADD COLUMN cursor_session_id TEXT`. Register both in `migrations/index.ts` (append order). db.ts: widen `getByIdOrKind` and `insert` kind literals; map `cursor_session_id` ⇄ `cursorSessionId` in the runs row mapper + an update helper mirroring codex's. Acceptance: fresh temp-dir DB migrates cleanly; existing harness rows survive the rebuild (FK/foreign_keys note: use the standard rebuild recipe).
- **T3 — driver.** Owns new `src/bun/cursor-tmux.ts` only. Clone codex-tmux: `cursorLogPath` (`dataDir/cursor-logs/`), `mapCursorEvent` written against the §2 event schema (system/init→sessionId; assistant→`assistant` stream; `tool_call started`→`tool_use`, `completed`→`tool_result` with generic envelope rendering; `result`→done(0) or done(1) on `is_error`; process-exit-without-result→failure), line_uuid per §3.6, `spawnCursorViaTmux` (prompt-as-argv injection-safe pattern per §3.7), `reattachCursorSession`, `dropCursorSession`, death-watch via the shared `claude-tmux.ts` primitives, temp-file cleanup on terminal. Same `SpawnedAgent` contract (`writeInput: () => false`).

**Wave 2** (wiring; disjoint files; all depend on Wave 1):
- **T4 — spawn layer.** Owns `src/bun/agents.ts`, `src/bun/agent-status.ts`, `src/bun/agent-discovery.ts`. `resolveBin`: real 3-way switch + `AGETOR_CURSOR_BIN` (default `cursor-agent`). `harnessEnv`: 3-way (cursor: HOME override from `harness.home`; never `CODEX_HOME`). `buildCommand`: extract/add cursor argv per §3.4/§3.5 (model flag passthrough, resume flag, no effort flag). Fake driver `AGETOR_CURSOR_DRIVER=fake` (synthetic `fake-cursor-session-<taskId>`). `spawnAgent`: third branch → `spawnCursorViaTmux`. agent-status: `INSTALL_HINTS.cursor` (curl installer), no tmux-REPL gate for cursor. agent-discovery: `discoverCursor()` best-effort (`cursor-agent --list-models`, parse lines, fall back `[]`) + wire into `refreshDiscoveredModels`.
- **T5 — orchestrator.** Owns `src/bun/orchestrator.ts`. All arms from §2: reattach-key + `canTryReattach` + `reattachCursorSession` in `reconcileOrphans`; `startTask` run-row seed + `onSessionId` third branch; `reconcileTaskSession`/`archiveTask`/`deleteTask` → `dropCursorSession`; `sendInput` → `sendCursorTurn` with `cursorTurnQueue`/`spawnCursorTurnNow`/`drainCursorQueue`/`findLastCursorSessionId` cloned from the codex quartet (resume via `cursorSessionId`).
- **T6 — API + commands.** Owns `src/bun/server.ts`, `src/bun/commands.ts`. server: widen POST /harnesses kind validator; add `"cursor"` to both `/agent-models` literals. commands: real switch in `builtinCommands` (cursor gets its own — initially empty — builtins list) and an explicit cursor branch in the discovery path returning `[]` (no `.cursor/` scanning yet; avoids the codex picker pitfall crashing/mislabeling).
- **T7 — UI + CLI.** Owns `src/mainview/components/AgentIcon.tsx`, `NewTaskForm.tsx`, `SettingsDialog.tsx`, `src/cli/commands/harness.ts`. AgentIcon: use `@lobehub/icons` Cursor glyph if exported, else a minimal inline SVG. NewTaskForm: `agentCache` seed for cursor + plan-tooltip branch. SettingsDialog: type-radio → three kinds + `grid-cols-3`; home-hint real switch (cursor: "HOME override"); experimental badge extended to cursor. CLI harness.ts: cursor login hint (`cursor-agent login`).

**Wave 3** (docs; done by orchestrator inline): CLAUDE.md cursor section mirroring the codex section; README roadmap line updated.

## 5. Work breakdown — test tasks

- **TT1 — command/effort unit tests.** Owns `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`. Cursor fixtures via existing `builtin`/`alias` helpers: argv assertions for auto vs ask, model passthrough, resume flag, `AGETOR_CURSOR_BIN`/`AGETOR_CURSOR_ARGS` overrides, harnessEnv HOME override; effort-support asserts empty efforts + DEFAULT_MODEL.
- **TT2 — driver unit tests.** Owns new `src/bun/cursor-tmux.test.ts`. `mapCursorEvent` against synthetic NDJSON fixtures (init/assistant/tool_call pair/result success/result error/unknown event fallback), line_uuid stability across replay.
- **TT3 — orchestrator e2e.** Owns new `src/bun/orchestrator-cursor.test.ts`. Clone of orchestrator-codex.test.ts: temp `AGETOR_DATA_DIR`, `AGETOR_CURSOR_DRIVER=fake`, `AGETOR_CURSOR_BIN=/bin/echo`, `harnesses.setEnabled("cursor", true)`; asserts run rows, `cursorSessionId` persistence, follow-up turn resume, delete teardown.

## 6. Execution waves

Wave 1: T1 ∥ T2 ∥ T3 → checkpoint (typecheck, commit). Wave 2: T4 ∥ T5 ∥ T6 ∥ T7 → checkpoint (typecheck, commit). Wave 3: docs (inline) → commit. Review (opus). Tests: TT1 ∥ TT2 ∥ TT3 → run suite (haiku) → fix loop (≤3 rounds).

## 7. Blast radius & risks

- **Codex/claude regressions:** T4/T5 touch shared dispatch code. Mitigation: additive branches only; full suite must stay green (existing codex/claude tests are the guard).
- **Migration 024 table rebuild:** riskiest change — data-loss potential if the copy misses columns. Mitigation: copy by explicit column list, test on temp DB, never edit applied migrations.
- **mapCursorEvent vs real CLI drift:** the schema is doc-verified but not live-verified (binary not installed). Mitigation: generic fallback rendering for unknown events; ship disabled-by-default; unknown-model/flag passthrough.
- **Rollback:** revert the branch; migrations are additive (new table shape is a superset; cursor rows simply unused).

## 8. Open questions / assumptions (autonomous-mode log)

1. **"Cursor SDK" interpreted as "integrate Cursor's agent"** — implemented via the CLI, not the npm `@cursor/sdk` (rationale §3.1). If the owner specifically wanted the npm SDK embedded, this is the one assumption that changes the architecture.
2. Prompt-over-stdin unverified → prompt passed as argv (injection-safe pattern mandated).
3. Cursor per-account home env var unknown → HOME override for additional-account harnesses.
4. Curated model list (§3.5) chosen from the live pricing table; `auto` default. Unknown ids pass through verbatim by house convention.
5. Ships **disabled by default** (house style); user opts in via Settings.
6. Denied-action behavior mid-headless-run undocumented → ask-mode is propose-only; acceptable for v1.
7. No `.cursor/` command/rules discovery in v1 (`commands.ts` returns empty for cursor).
8. Follow-up (not in scope): dedupe the codex/cursor one-shot turn-queue duplication; live-verify `mapCursorEvent` against a real `cursor-agent` run before enabling by default.
9. Both human gates (grill, plan approval) were self-approved under autonomous mode.
