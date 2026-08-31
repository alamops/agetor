# Plan — fx 0.0.7 compatibility update

| Field | Value |
| --- | --- |
| Date | 2026-08-31 |
| Source | agetor task "update fx.sh harness based on the most recent release: 0.0.7" (/implement run) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner (3-question pass; answers in §8) |
| Branch | feature/updade-fx-sh |
| Base SHA | 9b23119 |

## 1. Objective & success criteria

Bring the fx harness's version-truth (comments, docs, curated-catalog claims) up to fx 0.0.7 and land the one behavior improvement the release makes worthwhile: pre-flight gating of **expired, non-refreshable** fx logins. Success: typecheck green, full `bun test` green, Playwright e2e green, every "verified against 0.0.x" claim in the fx surface cites 0.0.7 with today's evidence, and an expired-non-refreshable login is refused at Start with a friendly hint instead of failing mid-turn with a raw RPC error.

## 2. Context & constraints (Phase 1 evidence)

Verified two independent ways on 2026-08-31 — binary probe of fx 0.0.7 (build `cef08aa0f178`, downloaded from `https://releases.fx.sh/v0.0.7/fx-macos-aarch64.tar.gz` into the scratchpad; artifacts under `scratchpad/spikes/fx-007-probe/`) and a full source-tarball diff of `github.com/vercel-labs/fx` v0.0.6…v0.0.7 (275 commits). Fleet dossier: JubarteAI knowledge `90c68fe0-7874-4020-9f33-ac0cfd1092c2`.

**Unchanged (integration-critical):** `fx acp --model --log-file` (acp_runner.zig 0-line diff); protocolVersion numeric 1 (string still -32602); `src/acp/server.zig` + `jsonrpc.zig` byte-identical → configOptions provider entry and permission kinds `allow_once`/`allow_always`/`reject_once` unchanged; exactly six `session/update` kinds (still no `agent_thought_chunk`/`plan`/`usage_update` — dormant mappings stay dormant); StopReason set; modes ask/auto/yolo; sandbox still retired; `--help` still "Fast, native coding agent for the terminal." (`FX_HELP_MARKER` safe, agent-status.ts:194); compiled default still `moonshotai/kimi-k3`; all 8 relevant env vars; still no FX_HOME; `models --json` shape unchanged (`shown_count`/`more_count` already existed in 0.0.6).

**Changed:** (a) `agent_message_chunk` now streams raw **Markdown source** instead of ANSI-stripped rendered text (prompt.zig flip; changelog: "ACP clients receive clean Markdown, and resumed responses no longer repeat text already delivered") — strictly better for agetor's transcript, no code change; (b) `status --json` gains an always-present `mcp:{…}` object + `mcp_config_warning`; `auth_expired`/`team` observed live on a real fx-login account (conditional fields; possibly pre-0.0.7); (c) `session/new`/`session/resume` now merge project `.mcp.json` servers (trust-gated `allow_acp_mcp`; new invalid_params error "MCP servers are unavailable in this runtime"); (d) new top-level `fx mcp` command family; `fx ask --json` gains `final_output`; ACP `session/list` gains cwd/pagination/title (agetor calls none of these); (e) 8 filesystem tools removed, `capability_search`/`skill_search` added (tool_call streams show different tool names; mapper renders generically); (f) `auth_help` text recased "Fx"→"fx"; (g) unauth catalog 230→234 ids — all 6 curated spot-check ids (incl. the 5 `catalogOnly` premium rows + `zai/glm-5.3-flash`) still present.

**Measured live on this machine:** `auth:"fx login"`, `auth_expired:true`, `auth_refreshable:true`, `team:"alamoweb"` — and in that state passive probes (`models --json`) do NOT refresh the token and return the **unauthenticated** 234-id catalog (`private_models_hidden:true`). So the signed-in 158-id reference view could not be re-measured this pass, and account-scoped discovery silently degrades to the unauth view on an expired login.

**Trap (recorded so nobody re-infers it):** `strings` on the binary shows `{"id":"mode"…}`/`{"id":"model"…}`/`{"id":"provider"…}` triplets that look like a richer ACP configOptions — they belong to 0.0.7's new inline-menu TUI; `server.zig` is byte-identical, the ACP wire did not change.

## 3. Approach & key decisions

1. **No driver behavior changes** — everything the driver depends on is spike- AND source-verified unchanged (evidence-based, not reasoning-based). The driver work is comment/doc truth only.
2. **Expired-login pre-flight (owner decision, §8 Q2):** in `probeStatus`, `auth !== "missing" && auth_expired === true && auth_refreshable === false` → `loggedIn:false` with fx's `auth_help` if present, else "fx login has expired — run fx login to sign in again." Expired-but-refreshable stays fail-open (fx may refresh on real use — a passive probe not refreshing proves nothing about `fx acp`). Absent/malformed `auth_expired`/`auth_refreshable` → exactly today's behavior. Zero type/UI changes: the gate rides the existing `loggedIn`/`authHelp` fields that startTask, Settings, Onboarding, NewTaskForm and `agetor harness ls` already consume.
3. **Curated catalog untouched** (owner: leave as-is) — all spot-check ids exist unauth on 0.0.7; the signed-in view is unverifiable this pass (expired token) and there's no evidence of change.
4. **Machine upgrade (owner: yes):** install 0.0.7 over `~/.local/bin/fx` via `curl -fsSL https://fx.sh/setup.sh | sh -s v0.0.7` after the test loop closes; verify `fx --version` → 0.0.7. Re-login stays with the owner.
5. House style: new plan doc (this file); `fx-0.0.6-compat.md` stays untouched as history.

## 4. Work breakdown — implementation tasks (Wave 1, all file-disjoint)

- **T1 — driver version-truth** · owns `src/bun/fx-acp.ts` (comments only; no code paths). Update the header "Protocol index" + "Facts verified" blocks (fx-acp.ts:74-135) and the inline 0.0.5+ citations: verified-versions list → v0.0.4/v0.0.6/v0.0.7; six-kinds claim re-verified at 0.0.7 (source + binary strings); NEW: agent_message_chunk payload is raw Markdown source as of 0.0.7 (was rendered text) + resumed responses no longer repeat delivered text; NEW: session/new|resume can merge project `.mcp.json` servers (trust-gated) — a task workdir carrying `.mcp.json` may surface MCP tool_calls / an invalid_params "MCP servers are unavailable in this runtime" error; quoted auth text recased "fx needs access…". Acceptance: no executable line changes (`git diff` shows comment-only hunks); typecheck green.
- **T2 — expired-login gate** · owns `src/bun/agent-status.ts`. Implement decision §3.2 in `probeStatus` (agent-status.ts:134-160); update its doc comment (0.0.7 facts: `mcp` object now always present, `auth_expired`/`team` conditional, the new gate rationale + fail-open matrix) and the FX_HELP_MARKER comment (re-verified 0.0.7). Acceptance: expired+non-refreshable → `{loggedIn:false, authHelp:<hint>}`; expired+refreshable / absent fields / malformed fields → unchanged behavior; existing tests still pass untouched.
- **T3 — probe/catalog comment truth** · owns `src/bun/agent-discovery.ts`, `src/bun/orchestrator.ts`, `src/shared/types.ts` (all comment-only). agent-discovery.ts:156-230: re-measured 0.0.7 (unauth 234; shape incl. shown_count/more_count existed since 0.0.6; expired-login degradation note). orchestrator.ts:923 freshAuth comment → cite v0.0.6/v0.0.7. types.ts: `HarnessStatus.loggedIn` contract comment (types.ts:215-222) gains the expired-non-refreshable case; DEFAULT_MODEL.fx comment (types.ts:1307-1319) + AGENT_OPTIONS.fx header (types.ts:1961-1970) → "re-verified 2026-08-31 on 0.0.7 (unauth view; signed-in view unverifiable — token expired)". Acceptance: comment-only hunks; typecheck green.
- **T4 — docs** · owns `CLAUDE.md`, `README.md`. CLAUDE.md fx bullet + confirm-on-quit/env-var rows: fold in the 0.0.7 facts above (verified-versions, markdown chunks, status fields + new gate, 234 unauth ids, `.mcp.json` note, six kinds re-verified). README: verify; expected no-op (no version pins found). Acceptance: claims match §2 exactly; no stale "0.0.6 is latest" phrasing anywhere.

(This plan file itself is written by the orchestrator in Phase 3 — not part of any task.)

## 5. Work breakdown — test tasks (Phase 6)

- **TT1** · owns `src/bun/agent-status.test.ts`, `src/bun/agent-discovery.test.ts`. agent-status.test.ts: probeStatus matrix — expired+non-refreshable → loggedIn:false + hint (fx auth_help honored when present, crafted fallback otherwise); expired+refreshable → true; auth_expired absent → true (regression); malformed (`auth_expired:"yes"`, `auth_refreshable:1`) → fail-open true; a full 0.0.7-shaped payload (mcp object, team, mcp_config_warning) parses fine. agent-discovery.test.ts: parseFxModels tolerates the full 0.0.7 payload with shown_count/more_count (assert existing tolerance explicitly).
- **e2e:** applies to the repo generally but adds nothing here — the only behavior change is server-side status parsing with no UI delta (fx e2e runs on stub binaries without `status --json` precisely to stay fail-open, and that path is untouched). Recorded decision: no new e2e; existing fx specs + full suite run in Phase 7 as regression guard. Run recipe (Phase 1): `bun run typecheck`; `bun test`; `bun node_modules/@playwright/test/cli.js test` (not bunx — known broken here; one Playwright run at a time; auto-manages Vite + per-worker headless backend).

## 6. Execution waves

- Wave 1: T1 ∥ T2 ∥ T3 ∥ T4 (disjoint files) → checkpoint commit.
- Phase 5 review (opus) → must-fixes to Phase 8.
- Phase 6: TT1 → commit. Phase 7: typecheck + bun test + Playwright. Phase 8: fix loop to green (≤3 rounds).
- Post-green: machine upgrade (§3.4), final report, fleet workdone + knowledge updates.

## 7. Blast radius & risks

- `probeStatus` feeds the 15s `/harnesses` poll, Settings, Onboarding, NewTaskForm, `agetor harness ls`, and startTask's gate — the gate change can now refuse a Start for expired-non-refreshable logins. That's the intended behavior; the fail-open matrix bounds the risk (absent fields = old behavior; every existing stub binary still yields `loggedIn:null`).
- Comment-only tasks (T1/T3/T4) carry near-zero runtime risk; the review still walks them for accuracy drift.
- `.mcp.json`-merge semantics is a documented risk, not a code change: agetor worktrees for repos carrying `.mcp.json` may see fx surface MCP tool calls (trust-gated by fx itself).
- Rollback: single revert of the branch commits; no migrations, no data shape changes.

## 8. Open questions / assumptions

Owner grill (2026-08-31, answered live): **Q1 scope** → Full update (docs + gate + tests). **Q2 expired auth** → Gate non-refreshable only; refreshable stays fail-open. **Q3 machine** → Upgrade `~/.local/bin/fx` to 0.0.7 this run; owner re-logins themselves later.

Assumptions logged: (A1) `auth_expired`/`auth_refreshable` semantics as observed live (boolean fields; expired+refreshable is a working state fx may self-heal) — if fx auto-refresh fails in practice the run still fails with fx's own -32600 text, same as today. (A2) Credential re-check on prompt/resume unchanged (no source diff found; initialize-gate behavior byte-matched 0.0.6) — driver's -32600 handling untouched. (A3) The signed-in catalog is assumed unchanged from the 158-id 0.0.6 measurement; unverifiable until the owner re-logins (recorded in comments as such).
