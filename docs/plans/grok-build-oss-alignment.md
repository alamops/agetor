# Plan — Grok Build OSS alignment (real schema, effort, discovery, tool stream)

| Field | Value |
| --- | --- |
| Date | 2026-07-15 |
| Source | /implement — xAI open-sourced Grok Build (github.com/xai-org/grok-build); review it vs our integration, fix issues, implement what's missing |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/21f644e90eb8-grok-build-code-integration (continuing) |
| Base SHA | 85019c7d2c553f335a5f27da4905db5c30b34258 (tree clean apart from this plan file) |

## 1. Objective & success criteria

Replace every doc-guessed piece of the grok integration with the source-verified contract from `xai-org/grok-build` (repo verified genuine; org rebranded "SpaceXAI"), and ship the four features the OSS release unblocks. Done means: assistant text/thinking render from real `text`/`thought` events; turns settle instantly on `end`/`error`; `ask` mode no longer passes the no-op `dontAsk`; prompt delivered via `--prompt-file`; effort knob live; skills/commands discovery live; session ids pre-seeded via `-s`; tool calls rendered from the session's `updates.jsonl`; typecheck + full `bun test` green.

## 2. Context & constraints (source-verified, repo-relative anchors into xai-org/grok-build @ b189869b)

**streaming-json contract** (`crates/codegen/xai-grok-pager/src/headless.rs`):
- `{"type":"text","data":<str>}` — assistant delta (`:372`, trigger `:1481`); no id; unbounded deltas per message.
- `{"type":"thought","data":<str>}` — thinking delta (`:387`); may be empty string.
- `{"type":"end","stopReason","sessionId","requestId",…spend}` — terminal success, always last on the success path (`:446-458`). **The ONLY event carrying `sessionId`** (top-level camelCase).
- `{"type":"error","message",…}` — terminal failure (`:472-478`); never carries sessionId.
- `max_turns_reached` (before `end`), `auto_compact_started|completed|failed|cancelled` (`percentage`/`error` fields), `auto_continue_completed` (`total_tokens`), `image_compressed` (`message`).
- **NO tool events** — the serializer's catch-all drops every ACP update except message/thought chunks (`:1507`). Docs mark the list non-exhaustive → keep a defensive fallback branch.
- Terminal event NOT guaranteed on signals (`main.rs:820-859` exits directly) — our exit-code sidecar remains load-bearing.
- Exit codes: 0 ok, 1 runtime/auth errors, 2 managed-policy/clap, 130/143/129 signals.

**CLI contract** (`crates/codegen/xai-grok-pager/src/app/cli.rs:404-726`):
- `--prompt-file <PATH>` exists (`:474-482`); `-p` is argument-only, headless never reads stdin (docs `14-headless-mode.md:303`).
- `--reasoning-effort/--effort` with `Effort::VALID_VALUES = ["low","medium","high","xhigh","max"]` (`xai-grok-agent/src/config.rs:992-1004`).
- `--permission-mode dontAsk` **parses but is a functional no-op** — only `bypassPermissions`/`always-approve` and `auto` are wired (`xai-grok-shell/src/util/config/permissions.rs:225-239`; docs `22-permissions-and-safety.md:1226-1232`). Headless default mode auto-cancels prompts (reported to model), no hang.
- `-s/--session-id <UUID>` = **new-session only** (valid UUID, must not exist); `--resume <id>` errors if not found; bare `--resume` = most recent.
- **Sandbox on resume**: explicit `--sandbox` differing from the session's stored profile → hard exit 1; **no flag → stored profile silently inherited** (`cli.rs:853-867` — `(None, saved) => Apply(saved)`, structurally cannot conflict). Aliases `readonly`≡`read-only`, `none`≡`off`.
- Default model `grok-build` (`xai-grok-models/default_models.json:2`); `grok-4.5`/`grok-4-fast-reasoning` exist only in test fixtures → drop from curated list (verbatim passthrough still covers typed ids).

**Session storage** (`xai-grok-config/src/paths.rs`):
- `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl` (+ `summary.json`, …).
- Encoding (`:112-126`): `urlencoding::encode(cwd)` if ≤255 bytes (encodes everything except `A-Za-z0-9-_.~` — note JS `encodeURIComponent` also leaves `!'()*` bare, must post-encode those); else `${slugify(leaf,40)}-${blake3(cwd).hex[..16]}`. **We avoid blake3 by scanning `sessions/*/<session-id>/` for our pre-seeded UUID as the fallback path.**
- `updates.jsonl` line = `{"timestamp":<unix-s>,"method":"session/update","params":{"sessionId","update":{"sessionUpdate":"<tag>",…}}}` — tag values `tool_call` (`toolCallId`,`title`,`kind`,`status`,`content[]`,`locations[]`,`rawInput`,`rawOutput`), `tool_call_update` (partial fields, same `toolCallId`; errors = `status:"failed"`, no is_error field), `plan` (`entries[{content,priority,status}]`), `user/agent_message_chunk`, `agent_thought_chunk`. Also `method:"_x.ai/session/update"` extension lines (subagents, rewind markers — ignore for now). **Written incrementally during the turn** (per-update O_APPEND, `jsonl/mod.rs:286-297,929-941`).
- File is per SESSION (multi-turn): tailing must dedup across turns, not assume per-run content.

**Local facts:** task `mode` is PATCHable mid-task (RunPanel.tsx:3269 → server PATCH), so sandbox-vs-resume needs handling. `runs.grok_session_id` exists; `seenLineUuidsForTask` is task-scoped (prior turns' persisted keys dedup replays).

## 3. Approach & key decisions

- **D1 — Mapper rewrite, exact-first + defensive tail:** switch `mapGrokEvent` on exact `type` values (`text`,`thought`,`end`,`error`,`max_turns_reached`,`auto_compact_*`,`auto_continue_completed`,`image_compressed`); keep the generic has-text fallback ONLY for unknown types (docs: non-exhaustive). Text field is `data`. `end` → `done(0)` + sessionId + a `status` chunk with stopReason (and cost fields when present); `error` → stderr + `done(1)`; `max_turns_reached`/`auto_compact_*` → `status` chunks.
- **D2 — Prompt via `--prompt-file`:** driver writes the prompt file (as today) and splices `--prompt-file <path>` into argv — no more `-p "$(cat …)"` command substitution; `exec` still dropped for the exit-code sidecar.
- **D3 — Mode mapping:** `auto` → `--permission-mode bypassPermissions --sandbox off` (unchanged, source-confirmed). `ask` → `--sandbox read-only` ONLY (drop the no-op `dontAsk`; headless default mode auto-cancels prompts without stalling).
- **D4 — Pre-seeded sessions:** orchestrator generates a UUID per new grok session, passes `-s <uuid>` on the first turn (persisting `grokSessionId` at run-insert), `--resume <uuid>` on follow-ups. `onSessionId` sniffing from `end` stays as confirmation/repair. Fake driver echoes the provided id.
- **D5 — Sandbox-consistent resume:** resume turns NEVER pass `--sandbox` (inherits stored profile; structurally cannot error). In-memory `Map<taskId, modeAtSessionStart>`: if current `task.mode` differs → start a FRESH session (`-s` new uuid, sandbox per new mode) instead of resuming. After a restart the map is empty → plain resume (safe, inherited sandbox).
- **D6 — Effort:** `MODEL_EFFORT_SUPPORT.grok["grok-build"]` = the intersection of agetor's canonical effort ids with `["low","medium","high","xhigh","max"]`; buildCommand emits `--effort <id>` when set. Default: omit the flag (owner preference, unanswered→assumed); if the picker machinery structurally requires a concrete default, use `medium` and log the deviation.
- **D7 — Models:** curate `grok-build` only; verbatim passthrough unchanged.
- **D8 — Tool stream from `updates.jsonl`:** second tailer per turn. Path = `GROK_HOME/sessions/{encodeCwd(cwd)}/{sessionId}/updates.jsonl` via TS reimplementation of the short-path encoding (encodeURIComponent + post-encode `!'()*`), with a **directory-scan fallback** (`sessions/*/<sessionId>/`) covering the blake3 long-path case and future encoding drift. Poll+watch (file may not exist yet). Always read from offset 0 (multi-turn file) and rely on task-scoped `seenLineUuids` dedup — identical mechanics for spawn and reattach. Map ONLY `tool_call`/`tool_call_update`/`plan` (skip message/thought chunks — the stdout stream owns those; skip `_x.ai/*` lines). Keys: `tc:${toolCallId}` for tool_call, `tcu:${toolCallId}:${status}` for updates (line-index fallback `upd:${n}` for malformed/id-less lines). `tool_call_update` with `status:"failed"` → tool_result with error flag. Graceful degrade: if the file never appears, rich tool rendering is simply absent.
- **D9 — Discovery:** `commands.ts` grok branch reads `GROK_HOME/skills/<name>/SKILL.md` (frontmatter `name`/`description`) + `GROK_HOME/commands/<name>.md` + project `.grok/skills|commands/`, appended to `GROK_BUILTINS`. Missing dirs → builtins only.

## 4. Work breakdown — implementation

**Wave 1 (3 agents, file-disjoint):**
- **T1 `src/bun/grok-tmux.ts`** — D1 mapper rewrite; D2 `--prompt-file` splice; D8 updates.jsonl tailer (path encode + scan fallback, envelope parsing, tool/plan mapping, offset-0 + dedup) wired into spawn AND reattach; driver accepts `sessionId` in launch/reattach opts (needed for the updates path); sidecar/death-watch unchanged.
- **T2 `src/shared/types.ts`** — `AGENT_OPTIONS.grok.models` → `grok-build` only; `MODEL_EFFORT_SUPPORT.grok` per D6; `DEFAULT_EFFORT.grok` per D6; mode hints updated for D3 wording.
- **T3 `src/bun/commands.ts`** — D9 discovery replacing the builtins-only branch.

**Wave 2 (2 agents, file-disjoint):**
- **T4 `src/bun/agents.ts`** — buildCommand grok branch: D3 ask mapping; `--effort` (D6); `-s <newSessionId>` vs `--resume <id>` with NO `--sandbox` on resume (D5) — extend the opts threading the way resume already flows; fake driver echoes the provided session id.
- **T5 `src/bun/orchestrator.ts`** — D4 UUID generation + persist-at-insert on grok run rows; D5 `modeAtSessionStart` map + fresh-session-on-mode-change in `sendGrokTurn`/`spawnGrokTurnNow`; thread `sessionId` into the driver opts; `findLastGrokSessionId` unchanged.

**Wave 3 (1 agent):**
- **T6 `CLAUDE.md`** — rewrite the grok bullet for the source-verified contract (real events, no tool events in stdout stream + updates.jsonl sidecar tailer, prompt-file, D3/D5 mode/sandbox semantics, effort, `-s` pre-seeding, models). Update the plan doc's amendment trail if needed.
- UI: expected zero edits (AGENT_OPTIONS drives pickers); orchestrator verifies at the wave-3 barrier via typecheck.

## 5. Work breakdown — tests (Phase 6, file-disjoint)

- **TT1 `src/bun/grok-tmux.test.ts`** — rewrite mapper tables for the real schema (text/thought `data`, end→done0+sessionId+status, error→done1, max_turns/auto_compact→status, unknown-type fallback retained, empty-string thought); updates.jsonl envelope mapping tests (tool_call, partial tool_call_update, failed status, plan, `_x.ai` lines skipped, message chunks skipped, dedup determinism); cwd-encoding unit tests (short path, chars `!'()*`, >255-byte fallback signalling).
- **TT2 `src/bun/orchestrator-grok.test.ts`** — pre-seeded id persisted at insert; resume uses the same id; mode-change spawns a fresh session id; queue/teardown tests updated for new argv flow.
- **TT3 `src/bun/agents.test.ts` + `src/bun/effort-support.test.ts`** — new argv shapes (ask = read-only only; `--effort`; `-s` new vs `--resume` without `--sandbox`; `--prompt-file` excluded from buildCommand argv — driver-spliced), grok-build-only models, effort support list.

## 6. Execution waves

W1 (T1∥T2∥T3) → typecheck barrier + commit → W2 (T4∥T5) → typecheck barrier + commit → W3 (T6) → full typecheck + commit → Phase 5 review (opus) → Phase 6 (TT1∥TT2∥TT3) → Phase 7 full run → Phase 8 fixes.

## 7. Blast radius & risks

- Mapper rewrite changes line_uuid shapes for grok events — no migration concern (dedup is per-run/per-task data, old Experimental runs just won't dedup against new keys; acceptable).
- updates.jsonl tailer adds a second fs poller per active grok turn — bounded, pruned on resolve.
- The repo is one day old and unversioned (bin crate `0.1.220-alpha.4` vs changelog `0.2.101`) — contract could still drift; defensive fallback branch + `AGETOR_GROK_ARGS` + sidecar remain the safety net.
- `-s` requires UUID format — `crypto.randomUUID()` satisfies it; collision (`already exists`) is practically impossible but surfaces as a spawn error → visible in run panel.
- Existing in-flight grok sessions (pre-change) resume fine: `--resume` + omitted sandbox inherits.

## 8. Open questions / assumptions

- **A1 (assumed, question unanswered in grill):** `ask` → `--sandbox read-only` only, no permission-mode flag.
- **A2 (assumed, question unanswered in grill):** no pinned `--effort` default; omit unless the picker machinery requires a value (then `medium`, logged).
- **A3:** `_x.ai/session/update` extension lines (subagent lifecycle) ignored in v1 — candidate for a follow-up (subagent tabs like claude's).
- **A4:** grok's own `--worktree` features unused — agetor owns worktree isolation.
- **A5:** contract verified against source, still not against a running binary (no compiled artifact/release exists yet).
