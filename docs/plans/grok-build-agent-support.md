# Plan — Grok Build (xAI) agent support

| Field | Value |
| --- | --- |
| Date | 2026-07-10 |
| Source | /implement — "xAI has launched Grok Build/Code, include its support into Agetor" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/21f644e90eb8-grok-build-code-integration |
| Base SHA | 55ef208778e3059ef74c07547607bdca8cb3f015 (tree clean apart from this plan file) |

## 1. Objective & success criteria

Add **`grok`** as a third `AgentKind` (product: **Grok Build**, xAI's CLI coding agent, binary `grok`), with full parity to the codex integration: create/start/follow-up/stop/delete tasks, structured run-panel streaming, restart-survivable turns, boot reconciliation, and Settings opt-in.

Done means:
- A task with agent=grok spawns `grok -p … --output-format streaming-json` per turn inside a detached tmux session, streams mapped events to the run panel, records `runs.grok_session_id`, and resumes follow-up turns via `--resume <id>`.
- Grok ships **disabled by default** with the amber **Experimental** badge (codex precedent); enabling it in Settings makes it appear in the New Task picker.
- `bun run typecheck` green; full `bun test` green (with tmux + bun on PATH).

## 2. Context & constraints (Phase 1 findings)

**Product facts** (docs.x.ai/build, x.ai/news/grok-build-cli, verified 2026-07-10):
- Binary `grok`; install `curl -fsSL https://x.ai/cli/install.sh | bash`. Early beta, changes daily.
- Headless one-shot: `grok -p "<prompt>" --output-format streaming-json` (NDJSON events). Prompt is an **argument**, not stdin (unlike codex's trailing `-`).
- Resume: `--resume <session-id>` / `-c`. Session id appears in JSON output (`sessionId`); session logs at `~/.grok/sessions` (relocatable via `GROK_HOME`).
- Permission modes: `ask` (default), `bypassPermissions` (aka `--yolo`), `dontAsk`, `acceptEdits`. Sandbox profiles (separate axis): `off | workspace | devbox | read-only | strict`.
- Models: `grok-build` (default coding model), `grok-4.5`, `grok-4-fast-reasoning`, others; `-m/--model`. No confirmed first-class CLI reasoning-effort flag.
- Auth: SuperGrok/X Premium+ OAuth (`grok login`, `~/.grok/auth.json`) or `XAI_API_KEY`. An existing OAuth login takes precedence over the env key.
- **UNCERTAIN:** exact `streaming-json` event taxonomy — not published verbatim. Mapper is built defensively (owner-approved).

**Codebase anchors** (from investigation):
- The codex driver (`src/bun/codex-tmux.ts`, ~590 lines) is the template: one-shot exec per turn wrapped in `sh -c 'exec <argv> > runlog 2>&1'` inside a detached tmux session; tail the NDJSON log (poll + fs.watch — macOS FSEvents drops cross-process appends); map events via `mapCodexEvent`; `line_uuid` idempotency (`${event.type}:${item.id}`, monotonic `seq.n` fallback); death-watch via `deathTickOutcome`/`DEATH_MISS_THRESHOLD` emitting `SESSION_DIED_STATUS_PREFIX`.
- Generic tmux primitives (`sessionNameFor`, `sessionExistsByName`, `sessionLiveness`, `deathTickOutcome`, `fileWrittenWithin`, `ChunkHandler`, `SpawnedAgent`) live in `claude-tmux.ts` and are imported by codex-tmux.ts — established convention, do the same.
- `buildCommand`/`spawnAgent` (`src/bun/agents.ts:250-409, 523-582`) currently **fall through to codex for any non-claude kind** — must become explicit branches.
- Orchestrator third-arm sites (`src/bun/orchestrator.ts`): `reconcileOrphans` reattach key + spawn (416-447), `startTask.onSessionId` (712-714), `reconcileTaskSession` (941-942), `sendInput` (1119-1139), turn queue machinery (`codexTurnQueue`/`sendCodexTurn`/`drainCodexQueue`, 1142-1281) to replicate as `grokTurnQueue`, `archiveTask`/`deleteTask` teardown (1698-1699, 1739-1740), `attachDoneHandler` drain call (886, 914).
- DB gates: `harnesses.insert` kind whitelist (db.ts:376-384), `getByIdOrKind` builtin fallback (db.ts:359-375), `RunRow`/`toRun` (db.ts:479-499). Migration `013_harnesses.sql` has `CHECK (kind IN ('claude-code','codex'))` — **SQLite requires a table rebuild** to widen it.
- Server gates: POST `/harnesses` kind validation (server.ts:606-611), `/agent-models` hardcoded keys (server.ts:857-872).
- UI: `SettingsDialog.tsx` kind array (747) + experimental badge (603, 748) + home-path copy (781-788); `NewTaskForm.tsx` agentCache seeds (168-170, 208-209); `RunPanel.tsx` `harnessKindOf` (58) — resume-picker and open-tmux stay claude-only; `App.tsx` agentModels seed (76); `AgentIcon.tsx` `ICONS: Record<AgentKind,…>` (4-20) — check `@lobehub/icons` for a Grok/XAI icon, else fall back to `Codex.Color`-style generic or an inline SVG.
- `agent-status.ts` `INSTALL_HINTS` (10-13); `agent-discovery.ts` `discoverCodex` pattern (63-86, 101-109); `commands.ts` capability picker (the #77 trap — codex's picker was empty because builtins were claude-only).

**Historical traps** (codex landing #66 + fixes #77/#78):
1. Any feature branching `=== "claude-code"` / two-way claude-vs-codex silently omits the new kind — grep for both before calling it done.
2. Workspace-scoped sandboxes break `git commit` in linked worktrees (`.git` is a file pointing outside the worktree) — avoided by decision D4 (sandbox off in auto).
3. Migrations are append-only; register in `migrations/index.ts` via text import.

**Peer-captured test traps:**
- `bun`/`tmux` are not on the non-interactive PATH: prefix toolchain commands with `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"`.
- bun test shares ONE SQLite DB across files — never leave `status='running'` rows behind (pollutes `reconcile.test.ts`).
- `spawnAgent` calls `buildCommand` even under the fake driver — test tasks must set `model` + `effort`.
- Fresh worktree has no `node_modules` — run `bun install` first.

## 3. Approach & key decisions (owner-approved in Phase 2)

- **D1 — Driver pattern:** mirror `codex-tmux.ts` (one-shot exec per turn in detached tmux, tail own NDJSON log). Not the claude REPL pattern, not ACP `grok agent stdio` (persistent stdio JSON-RPC wouldn't survive an agetor restart and needs new plumbing).
- **D2 — Defensive event mapper:** `mapGrokEvent` handles documented/likely shapes — text/assistant-message events → `assistant`, reasoning/thinking → `thinking`, tool/command events → `tool_use` + `tool_result`, errors → `stderr`, anything unrecognized with text content → generic `tool_use` fallback (forward-compat, mirrors codex), malformed lines → `stderr`. Session id sniffed from any event carrying `session_id`/`sessionId`. Ship Experimental; refine from the first real log.
- **D3 — `line_uuid` scheme:** natural ids when present (`${type}:${id}`); deterministic fallback keyed to the NDJSON line index within the run log (stable across reattach because the log is re-read from offset 0). Never wall-clock.
- **D4 — Mode mapping:** `auto` → `--permission-mode bypassPermissions --sandbox off` (agetor's no-sandbox philosophy; avoids the worktree-git trap — no escalation machinery needed). `ask` → `--permission-mode dontAsk --sandbox read-only` (never stalls headless; read-only ops are auto-approved even under dontAsk). `CODE_PLAN_MODE.grok = { code: "auto", plan: "ask" }`.
- **D5 — Models:** curate `grok-build` (default), `grok-4.5`, `grok-4-fast-reasoning`; ids pass to `-m` verbatim (no translation table). **No effort knob in v1**: `MODEL_EFFORT_SUPPORT.grok` maps every model to `[]` (picker collapses, Haiku-4.5 precedent).
- **D6 — Own session column:** `runs.grok_session_id` (codex precedent: id namespaces are not interchangeable).
- **D7 — Rollout:** builtin harness row seeded `enabled=0` + Experimental badge in Settings (codex precedent).
- **D8 — Prompt delivery:** prompt written to a per-run file (restart-survivable, avoids tmux quoting hell) and delivered as `sh -c 'exec "$BIN" -p "$(cat <promptfile>)" … > runlog 2>&1'` since `-p` takes an argument, not stdin.
- **D9 — Env/overrides:** `AGETOR_GROK_BIN`, `AGETOR_GROK_ARGS`, `AGETOR_GROK_DRIVER=fake`; `harnessEnv` maps alias-harness `home` to `GROK_HOME` (mirrors `CODEX_HOME`). Install hint: `curl -fsSL https://x.ai/cli/install.sh | bash`.
- **D10 — Explicit dispatch:** `buildCommand`/`spawnAgent`/orchestrator branches become explicit `claude-code | codex | grok` chains; unknown kinds error rather than falling into the codex path.

## 4. Work breakdown — implementation tasks

**Wave 1 — foundation (3 agents, file-disjoint).** Typecheck is expected red *between* tasks and green at the wave barrier (widening `AgentKind` breaks `Record<AgentKind,…>` consumers until all wave-1 files land). The plan pins exact symbol names so agents can code against each other's not-yet-written surfaces.

- **T1 `src/shared/types.ts`** — widen `AgentKind` with `"grok"`; add `AGENT_OPTIONS.grok` (models per D5; modes `auto`/`ask` per D4 with hints; efforts `[]`), `DEFAULT_MODEL.grok = "grok-build"`, `DEFAULT_EFFORT.grok` (mirror the no-effort convention used by kinds/models without an effort flag), `MODEL_EFFORT_SUPPORT.grok` (all curated models → `[]`), `MODEL_MODE_DENY.grok` (all `[]`), `CODE_PLAN_MODE.grok = { code: "auto", plan: "ask" }`, `HARNESS_TEMPLATES` grok entry, `Run.grokSessionId?: string | null` (+ docstring mirroring codexSessionId). Acceptance: file self-consistent; downstream compile errors are wave-siblings' jobs.
- **T2 migrations** — `src/bun/migrations/024_grok_harness.sql`: rebuild `harnesses` widening CHECK to `('claude-code','codex','grok')` (create-new/copy/drop/rename, preserve indexes/triggers if any) + `INSERT OR IGNORE` builtin grok row with `enabled=0` (mirror 013's seed + 016's disable pattern); `025_grok_session_id.sql`: `ALTER TABLE runs ADD COLUMN grok_session_id TEXT;`. Register both in `migrations/index.ts` (append-only). Files owned: the two new .sql + `index.ts`. *[Amended post-review: renumbered twice — first to 026/027 (cursor branch expected to take 024/025), then to `028_grok_harness.sql`/`029_grok_session_id.sql` after main independently landed migrations 024–027; both AgentKind branches' rebuilds share a four-kind CHECK (`claude-code, codex, cursor, grok`) so they're order-independent.]*
- **T3 `src/bun/db.ts` + `src/bun/grok-tmux.ts` (new)** — db.ts: widen `harnesses.insert` whitelist and `getByIdOrKind` builtin fallback to include `"grok"`; add `grok_session_id` to `RunRow`/`toRun`/insert/update plumbing. grok-tmux.ts: full driver mirroring codex-tmux.ts — `GROK_LOG_DIR` (`dataDir/grok-logs/<runId>.jsonl`), `mapGrokEvent` (D2), line_uuid scheme (D3), `spawnGrokViaTmux`, `reattachGrokSession`, `grokSessionActive`, `dropGrokSession`, death-watch emitting `SESSION_DIED_STATUS_PREFIX`, poll+watch tailer, prompt-file + `sh -c` wrapper (D8), prune log/prompt files on resolve. Import generic primitives from claude-tmux.ts (convention). `writeInput` is a no-op (one-shot).

**Wave 2 — wiring (3 agents, file-disjoint).**

- **T4 `src/bun/agents.ts` + `src/bun/agent-status.ts` + `src/bun/agent-discovery.ts` + `src/bun/login-path.ts`** — agents.ts: `resolveBin` third branch (`"grok"` + `AGETOR_GROK_BIN`); `harnessEnv` explicit grok branch (`GROK_HOME`); `buildCommand` explicit grok branch building `[-p <prompt>, --output-format streaming-json, -m <model>, mode flags per D4, [--resume <id>]]` — verify against codex's structure how prompt/resume are threaded (driver may inject the prompt-file itself; keep `buildGrokCommand(harness, prompt, opts, cwd)` seam mirroring `buildCodexCommand`); `spawnAgent` explicit grok dispatch to `spawnGrokViaTmux` + `AGETOR_GROK_DRIVER=fake` fake path (happy-path fake: stdout chunk + completing status). agent-status.ts: `INSTALL_HINTS.grok` (D9). agent-discovery.ts: `discoverGrok()` stub following `discoverCodex` (empty result is fine if grok has no model-listing command — keep cache shape valid). login-path.ts: add `grok` to `PROBEABLE_COMMANDS`.
- **T5 `src/bun/orchestrator.ts`** — third arms everywhere (Phase-1 anchor list): `reconcileOrphans` reattach key (`grok_session_id`) + `reattachGrokSession` spawn; `startTask.onSessionId` → `{ grokSessionId }`; `reconcileTaskSession` + `archiveTask` + `deleteTask` → `dropGrokSession`; `sendInput` third `if` routing to grok turn logic; replicate the codex turn queue as `grokTurnQueue`/`sendGrokTurn`/`spawnGrokTurnNow`/`drainGrokQueue`/`findLastGrokSessionId` (or, if trivially parameterizable by kind, generalize the existing queue — implementer's call, prefer the smallest faithful diff); `attachDoneHandler` drains the grok queue like the codex one.
- **T6 `src/bun/server.ts` + `src/bun/commands.ts`** — server.ts: widen POST `/harnesses` kind validation; add `"grok"` to `/agent-models` GET/POST; leave `/tasks/:id/open-tmux` claude-only. commands.ts: add a grok branch to `listAvailableCommands` reading user/project `~/.grok`-style skill/command conventions **only if trivially discoverable from docs already gathered** — otherwise return `[]` explicitly for grok (graceful degrade, documented decision; avoids trap #77's silent-omission by making it an explicit branch).

**Wave 3 — UI + docs (2 agents, file-disjoint).**

- **T7 `src/mainview/`** — `App.tsx`: agentModels seed gains `grok: []`. `AgentIcon.tsx`: add grok icon (`@lobehub/icons` `Grok`/`XAI` component if it exists in the installed version — check `node_modules` after `bun install`; else a reasonable fallback icon). `NewTaskForm.tsx`: seed `agentCache` for grok; effort-hint branch already keys off supportedEfforts (verify collapse). `RunPanel.tsx`: verify `harnessKindOf` fallback and that grok is excluded from claude-only affordances (resume picker, open-tmux). `SettingsDialog.tsx`: add `"grok"` to the kind array (747), Experimental badge for grok, home-path suggestion copy (`~/.grok`).
- **T8 `CLAUDE.md`** — document the grok agent command shape in "Agent command shape" (living-doc convention from #66/#77/#78): one-shot streaming-json turns, resume via `--resume`, D4 mode mapping and why sandbox is off in auto, `AGETOR_GROK_*` overrides, disabled-by-default rollout.

## 5. Work breakdown — test tasks (Phase 6, after review)

- **TT1 `src/bun/grok-tmux.test.ts` (new)** — table-driven `mapGrokEvent` tests via the `collect()` fake-onChunk pattern from codex-tmux.test.ts: assistant/thinking/tool events, unknown-kind fallback, malformed line → stderr, line_uuid determinism across a simulated re-read, session-id sniffing.
- **TT2 `src/bun/orchestrator-grok.test.ts` (new)** — mirror orchestrator-codex.test.ts with `AGETOR_GROK_DRIVER=fake`: start task → running → review; follow-up while busy queues (grokTurnQueue) and drains; session-id persisted; archive/delete teardown; temp `AGETOR_DATA_DIR`; tasks set model+effort (fake driver still runs buildCommand); leave no `running` rows behind.
- **TT3 extensions to existing files** — `agents.test.ts` (grok buildCommand: argv shape, mode flags per D4, `-m` passthrough, resume arg, env overrides, `AGETOR_GROK_ARGS`); `effort-support.test.ts` (grok models → no efforts; DEFAULT_MODEL.grok); `agent-status.test.ts` (grok availability via `AGETOR_GROK_BIN=/bin/echo`, install hint); `harnesses.test.ts` (insert/getByIdOrKind accepts grok; builtin row disabled); a migration-shape assertion if the existing db tests cover CHECK widening.

TT1/TT2/TT3 own disjoint files — one wave.

## 6. Execution waves

1. Wave 1: T1 ∥ T2 ∥ T3 → barrier → `bun install` (fresh worktree) + `bun run typecheck` (expected: red only in files owned by wave 2/3; note them) → commit.
2. Wave 2: T4 ∥ T5 ∥ T6 → barrier → typecheck (must be green except mainview files) → commit.
3. Wave 3: T7 ∥ T8 → barrier → full typecheck green → commit.
4. Phase 5 review → Phase 6 tests (TT1 ∥ TT2 ∥ TT3) → Phase 7 run (`export PATH=…; bun test`) → Phase 8 fixes if needed.

## 7. Blast radius & risks

- **Migration 028 (né 024) rebuilds `harnesses`** — data-preserving copy required; runs/tasks reference harness ids only informally (agent column stores id/kind strings), but verify no FK points at harnesses before dropping. Migration runs in a transaction via migrate.ts.
- **Event mapper is speculative** (D2): worst case, a real grok run renders mostly as generic tool_use/stdout until refined. Contained: Experimental + disabled by default.
- **CLI churn**: Grok Build is early beta with daily releases; flags may drift. Mitigated by verbatim model passthrough + `AGETOR_GROK_ARGS` escape hatch.
- **`grok -p` prompt-length limits via argv**: macOS ARG_MAX ~1MB — fine for typical prompts; noted as a known bound.
- **OAuth-precedence gotcha**: a stale `grok login` session overrides `XAI_API_KEY` — documented in CLAUDE.md (T8), not solved in code.
- **Existing tests that enumerate kinds** (e.g. settings/harness tests, server-auth fixtures) may hard-assert two kinds and need updating — TT3/Phase 8 catches these.

## 8. Open questions / assumptions

- **A1**: real `streaming-json` event names/shape unknown → defensive mapper (owner approved). Refinement pass expected after first real run.
- **A2**: no CLI reasoning-effort flag confirmed → no effort knob in v1 (owner approved).
- **A3**: `grok` has no documented model-listing command for agent-discovery → discovery returns empty; picker uses the curated list.
- **A4**: assumed no git-repo requirement for grok (not documented either way); `--skip-git-repo-check`-style flag not needed.
- **A5**: exact current CLI version unverified locally (binary not installed); flags sourced from docs.x.ai fetched 2026-07-10.
