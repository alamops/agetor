# Plan — Stop tmux sessions being killed unexpectedly (socket isolation + kill-path hardening)

| Field | Value |
| --- | --- |
| Date | 2026-07-08 |
| Source | Task 32511312: "TMux sessions are being closed unexpectedly, and it seems to be killed by Agetor. Besides checking the killing possibilities, check also the background agent support we've recently added." |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/32511312afd3-tmux-sessions-is-being-closed |
| Base SHA | 223e010e3ebdc3f712ec4c90927ee8f331adae3d |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (agetor-driven run, owner unavailable mid-task). All assumptions logged in §8. |

## 1. Objective & success criteria

Make it impossible for agetor's own tooling to take down live agent tmux sessions, and fix the adjacent kill/false-fail paths found during investigation.

Done means:
- `bun test` (any invocation, including by dogfooding agents) **cannot touch the user's production tmux server** — verified by test.
- No agetor kill/probe uses a prefix-matchable tmux target.
- A transient tmux probe failure can no longer route a live mid-turn session into the destructive respawn pre-kill.
- A background agent's transient API error can no longer mark a healthy reattached run `failed`/`blocked`.
- `bun run typecheck` green; full suite green.

## 2. Context & constraints (Phase 1 findings)

**The incident (2026-07-08, forensically reconstructed — three independent clocks agree):**
- The installed app (built 12:02, contains all of #85/#86/#88/#81 — verified by grepping the packaged `bun/index.js`) ran throughout; it did **not** issue the kills.
- 12:15:48 — a zombie claude session (task c417fa21, orphaned Jul 7 during two `bun` crashes, surviving *outside* tmux) ran `bun test` (full suite) in its worktree.
- 12:15:54.072 — the shared **tmux server (pid 15503) died**; its last unified-log entries are a 12 ms command flurry matching `claude-followup-restart.test.ts`'s `new-session`/`kill-session`×2 burst. That test `delete`s `AGETOR_TMUX_BIN` → PATH tmux → **the user's default socket**.
- Server death killed *every* live agetor session (tasks 3ab5f311 + f112c62e, both mid-turn). The #88 death-watch then *correctly* flagged both runs (`no server running` ⇒ unambiguous `gone`) → `failed`/`blocked`. 12:17:56 — the next task start spawned a fresh server (`#{start_time}` proves prior server death).
- Isolated-socket reproduction: both main's and the branch's full suites issue exactly **4 tmux commands, all self-scoped**; canaries + server survive. The exact in-tmux crash mechanism (tmux 3.6a) did not reproduce under 200-iteration churn + poller + attached client — but the *blast radius* exists only because tests share the production socket. Socket isolation removes the class regardless of mechanism.
- **Proven footgun:** tmux target prefix-matching — `kill-session -t agetor-aaaa` kills `agetor-aaaa1111-bbb` when the exact name is absent and the prefix is unambiguous (empirically verified).

**Adjacent real bugs found (kill-path + background-agent audits):**
- `sendClaudeTurn` (src/bun/orchestrator.ts:1070) gates on raw boolean `sessionExists()` (src/bun/claude-tmux.ts:734) — the exact fragile probe #88 replaced for the death-watch, never migrated here. A transient probe failure routes a **live mid-turn session** to `spawnResumedSession` → `spawnClaudeViaTmux`'s unconditional pre-kill (src/bun/claude-tmux.ts:2786) → agetor kills its own live session.
- `reconcileOrphans`' `priorApiError` query (src/bun/orchestrator.ts:353-358) matches `run_events` rows with `data LIKE 'api error: %'` **without `AND subagent_id IS NULL`**. Since #81, subagent tailers persist their own api-error status rows under the parent run — a background agent's transient 429/529 wrongly settles a healthy reattached run `failed` → `blocked`. **This is the background-agent connection the task asked about** (the subagent feature itself never kills tmux — audited clean).
- `seenLineUuidsForTask` (src/bun/db.ts:~598) unions subagent line-uuids into the main tailer's dedup set (harmless today, same missing-filter class).
- `attachSubagentWatcher`'s rehydration loop (src/bun/claude-subagents.ts:~205-221) is the only unguarded body in that file; a throw would propagate into `reattachSession`/the spawn IIFE.

**Constraints:** tmux invocations must keep flowing through the existing choke points (`tmux()` in claude-tmux.ts:714, the `spawnSync` runner in codex-tmux.ts:~465, `resolveTmuxBin()` in tmux-resolution.ts). Production behavior (no env set, not under test) must be byte-identical except for `=`-exact targets. Attach flows (server.ts:1122 osascript; src/cli/commands/attach.ts:41) must honor any active socket.

## 3. Approach & key decisions

1. **Socket isolation (primary fix):** new `tmuxSocketName()`/`tmuxSocketArgs()` in `tmux-resolution.ts`. Precedence: `AGETOR_TMUX_SOCKET` env (value `default` ⇒ force default socket) → `NODE_ENV === "test"` ⇒ `"agetor-test"` (bun test sets NODE_ENV=test) → null (production default socket). Every tmux spawn site threads `...tmuxSocketArgs()` in. This makes the whole suite structurally unable to reach the production server, even for tests that delete `AGETOR_TMUX_BIN`. *Rejected alternative:* per-test-file socket env — too easy for a future test to forget; the helper-level NODE_ENV net catches all of them.
2. **Exact-match targets:** `has-session`/`kill-session` use `-t =<name>`. Scoped to probe/kill only (not `send-keys`/`paste-buffer` pane targets) to keep the diff surgical. `sessionLiveness`'s string classification still matches (`"can't find session: =x"` contains `"find session"`).
3. **Liveness-aware follow-up gate:** `sendClaudeTurn` routes to the existing-session paste path when `hasSessionState(taskId)` and `sessionLiveness(name) !== "gone"`. `unreachable` (transient hiccup) now prefers the non-destructive path — if the session is genuinely dead the paste fails gracefully and the death-watch/boot-reconcile handles it; only an unambiguous `gone` (or missing state) reaches the respawn pre-kill.
4. **Subagent row filters:** `AND subagent_id IS NULL` on `priorApiError` and `seenLineUuidsForTask`; verify subagent replay dedup still holds via the `(run_id, IFNULL(subagent_id,''), line_uuid)` unique index. Guard the rehydration loop with try/catch.
5. **Not in scope (follow-up recommended):** running agetor's *production* sessions on a dedicated `-L agetor` socket (protects agents from anything users/tools do to the default server). User-visible behavior change + live-session migration on upgrade — needs owner sign-off.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | `tmuxSocketName()`/`tmuxSocketArgs()` in tmux-resolution.ts; thread socket args + `=`-exact probe/kill targets through claude-tmux.ts | `src/bun/tmux-resolution.ts`, `src/bun/claude-tmux.ts` | — | All tmux spawns in claude-tmux include socket args; has-session/kill-session use `=`; production (no env, no test) unchanged |
| I2 | Thread socket args + `=`-exact targets through codex driver | `src/bun/codex-tmux.ts` | contract from I1 (specified in brief) | Same as I1 for codex |
| I3 | Liveness-aware `sendClaudeTurn` gate; `AND subagent_id IS NULL` on priorApiError | `src/bun/orchestrator.ts` | contract from I1 (sessionLiveness already exported) | Gate never respawns on `unreachable`; subagent api-error rows don't seed `handle.apiError` |
| I4 | `seenLineUuidsForTask` subagent filter; guard subagent rehydration; attach flows honor socket | `src/bun/db.ts`, `src/bun/claude-subagents.ts`, `src/bun/server.ts` (line ~1122 only), `src/cli/commands/attach.ts` | contract from I1 | Filter added + dedup verified; try/catch; attach commands include socket args when a socket is active |

All four are file-disjoint → **one wave**.

## 5. Work breakdown — test tasks

| ID | Covers | Owns |
| --- | --- | --- |
| T1 | Socket resolution (env precedence, NODE_ENV=test default, `default` escape hatch); assert suite runs isolated; teardown hygiene for real-tmux tests | new `src/bun/tmux-socket.test.ts`, edits to `src/bun/claude-followup-restart.test.ts`, `src/bun/reconcile.test.ts` |
| T2 | Gate routing on `unreachable` (no pre-kill); exact-match kill args; priorApiError subagent filter (seed subagent api-error row → reattach → apiError stays false; NULL row → true) | new `src/bun/claude-turn-routing.test.ts`, new/extended `src/bun/reconcile-subagent-apierror.test.ts` |

File-disjoint → one wave.

## 6. Execution waves

1. **Wave 1 (impl):** I1 ∥ I2 ∥ I3 ∥ I4 → barrier → typecheck + commit.
2. **Phase 5 review** (opus) of `git diff 223e010e...HEAD`.
3. **Wave 2 (tests):** T1 ∥ T2 → barrier → commit.
4. **Phase 7:** full `bun test` + typecheck (haiku) → Phase 8 fix loop (≤3 rounds).

## 7. Blast radius & risks

- Socket args change every tmux invocation → if any spawn site is missed the suite splits across two servers; mitigated by grepping both drivers for `resolveTmuxBin`/spawn sites in I1/I2 briefs and by T1's isolation assertion.
- `=`-exact targets on tmux < 2.1 would break — bundled tmux and system 3.6a both fine.
- `unreachable`-prefers-paste could delay recovery when a session is genuinely dead but only ever reports unrecognized errors — degraded path is the death-watch/boot-reconcile, same conservative bias #88 chose.
- Old worktrees pinned to pre-fix base shas still carry dangerous tests (task 3ab5f311's worktree is at v0.0.16 **with the pre-#85 kill sweep**) — unfixable retroactively; agents pick the fix up on their next `merge origin/main`. Flagged in final report.

## 8. Open questions / assumptions (autonomous mode)

- **A1:** Test isolation via NODE_ENV=test default is acceptable even for power users who deliberately set `AGETOR_TMUX_BIN` — the `AGETOR_TMUX_SOCKET=default` escape hatch preserves an override.
- **A2:** Production sessions stay on the default socket for now (no migration risk taken without owner sign-off); dedicated-socket production isolation proposed as follow-up.
- **A3:** `=`-exact scope limited to has-session/kill-session; send-keys/paste targets unchanged.
- **A4:** The exact tmux 3.6a server-death mechanism is unproven (correlation is conclusive; mechanism is not) — socket isolation is the correct fix regardless.
- **A5:** Both gates (grill, plan approval) bypassed per autonomous mode; this plan is the audit trail.
