# Plan — Catch claude TUI "Unknown command: /…" and move the task to blocked

| Field | Value |
| --- | --- |
| Date | 2026-07-20 |
| Source | agetor task (screenshot: `Unknown command: /skill-creator` after user message) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/untraecable-unknown-command-error |
| Base SHA | a1911e2a873dfd85ce4b516e11bf63d2452a43ae |
| Mode | **Autonomous** — grill & plan-approval gates bypassed (agetor-driven session, no owner present); assumptions logged in §8 |

## 1. Objective & success criteria

When a user message whose first line starts with `/` is delivered to a claude-code task and claude's TUI rejects it with `Unknown command: /<name>` (no turn starts, no JSONL is ever written), agetor must:

- detect it within ~10s (scraper cadence),
- emit a `status` stream line explaining what happened,
- resolve the stuck turn, record the run as `failed`,
- move the card to `blocked` with a new reason `"unknown-command"`,
- show a distinct toast in the UI.

Success = orchestrator contract test proves blocked+failed+reason; matcher/signal unit tests pass; full suite + typecheck green.

## 2. Context & constraints (Phase 1 findings)

- Prompt delivery is verbatim: `pastePromptSync` (claude-tmux.ts:4742) does `load-buffer`/`paste-buffer -p`/`send-keys Enter`; bracketed paste does **not** stop claude's Ink TUI from dispatching a first line starting with `/` as a slash command. No escaping exists anywhere.
- When the command is unknown, **no JSONL line is ever written** and the tmux session stays alive → the death watch (`startDeathWatch`, gated on `tmux has-session`) structurally cannot see it, and there is **no turn timeout**. `turnInFlight` stays true forever; the run sits in `running`.
- The pane scraper (`startScraper` → `scrapeOnce`, claude-tmux.ts:3147/3317, 1s cadence throttled to 2s/10s when JSONL-idle) already captures the pane tail (40 lines) and is the right detection hook.
- The settle template is `signalSessionDeath` (claude-tmux.ts:3371): emit sentinel `status` chunk via the head slot's `onChunk` (or `onEndOfTurn` for reattach), resolve the slot with code 0, let an orchestrator handle-flag drive `failed` + `blocked`. **Unlike** session-death, we must NOT tear down watchers/timers — the session and claude process remain alive and reusable.
- Orchestrator consumption pattern: `makeChunkHandler` (orchestrator.ts:859) has parallel branches for `CLAUDE_API_ERROR_STATUS_PREFIX` (873-886) and `SESSION_DIED_STATUS_PREFIX` (891-900) → set `ActiveRun` flag + `updateColumn(taskId, runId, "blocked", <reason>)`; `attachDoneHandler` (926) maps flag → run `failed`, column `blocked`.
- Reason union lives in exactly two places: `updateColumn` param (orchestrator.ts:303) and `GlobalEvent` column variant (shared/types.ts:1737). UI branch: App.tsx:377-389; toasts in mainview/lib/toasts.ts (98/105/112). Unknown reasons fall through to the generic `toastPending` — fine as fallback but we add a distinct toast.
- Test seams: fake driver (`AGETOR_CLAUDE_DRIVER=fake`, agents.ts:485-535/570) with per-scenario env flags (`AGETOR_FAKE_CLAUDE_API_ERROR`, `AGETOR_FAKE_CLAUDE_SESSION_DIED`); `orchestrator-blocked.test.ts` asserts the contract; `claude-tmux-death.test.ts` drives `__forTest.installSession`/`pushTurnSlot`/`signalSessionDeath` against a synthetic SessionState; `claude-tmux-scraper.test.ts` feeds pane-text fixtures to pure matcher fns.

## 3. Approach & key decisions

**Detect, don't prevent.** Defanging the leading `/` (e.g. prefixing a space) would break *legitimate* slash-command use (`/compact`, real skills) — users do send those on purpose. The task asks for detection → blocked. (Logged as assumption A1.)

**Armed, token-matched scrape detection.** To make false positives ~impossible (e.g. a bash tool printing "Unknown command:" into the pane, or an assistant quoting it):

1. When a prompt whose **first line starts with `/`** is delivered (`sendTurn`, `pasteFollowUp`, and the spawn paths — argv prompt + `deferredPrompt`), record the slash token on `SessionState` (e.g. `pendingSlashToken: string | null = "/skill-creator"`). Non-slash prompts clear it. It is also cleared whenever a turn resolves (`popEndOfTurn` / slot resolution) and on first JSONL append after the paste (the command was real and ran).
2. `scrapeOnce` gains a matcher `matchUnknownCommand(tailLines)`: scans only the last ~12 non-blank lines for a line that (after stripping a leading `●`/whitespace) starts with `Unknown command: /<token>`; returns the token.
3. Fire only when: `pendingSlashToken` is set **AND** matcher's token equals it **AND** `turnInFlight(state)`.
4. On fire → new `signalUnknownCommand(state)`: emit sentinel `status` chunk, clear `pendingEndTurn` + `holdUntilIdle` + `pendingSlashToken`, resolve head slot with 0 (or fire `onEndOfTurn`), one-shot re-entry guard. **Do not** stop scrape/death/poll timers.

**Sentinel & reason.** New `CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX = "unknown command: "` defined in claude-tmux.ts (claude-only, mirrors `CLAUDE_API_ERROR_STATUS_PREFIX`; shared/types.ts is only for cross-driver sentinels). New reason literal `"unknown-command"` in both union sites. Orchestrator: `ActiveRun.unknownCommand` flag, `makeChunkHandler` branch mirroring the api-error one (gated `kind === "claude-code"`), `attachDoneHandler` → run `failed`, column `blocked`.

**Message content.** Sentinel payload: `unknown command: /skill-creator — claude treated the message as a slash command; it was not delivered. Edit the message so it doesn't start with "/" and resend.` (prefix + detail, mirroring the other sentinels).

**Alternatives considered.** (a) JSONL-silence timeout on every turn — rejected: long tool runs are legitimately silent; timeout value is unknowable. (b) Un-gated pane regex — rejected: tool output / quoted text false positives. (c) Prevention by escaping — rejected above.

## 4. Work breakdown — implementation (one wave, one task)

The change is a single coherent seam (sentinel name, state field, reason literal must agree across files) — splitting it across parallel agents risks drift, so it is **one task, one agent**.

**T1 — full vertical slice.** Owns: `src/bun/claude-tmux.ts`, `src/bun/orchestrator.ts`, `src/bun/agents.ts`, `src/shared/types.ts`, `src/mainview/App.tsx`, `src/mainview/lib/toasts.ts`. Must NOT touch any `*.test.ts`.
- claude-tmux.ts: sentinel const; `pendingSlashToken` on SessionState (cleared in dispose); arm/clear at the four delivery points; `matchUnknownCommand`; `scrapeOnce` hook; `signalUnknownCommand`; export new pieces via `__forTest`.
- orchestrator.ts: import sentinel; `unknownCommand` on `ActiveRun` + `registerActiveRun` default; `makeChunkHandler` branch; `attachDoneHandler` `wasUnknownCommand` → `failed`/`blocked`; `updateColumn` reason type.
- shared/types.ts: `"unknown-command"` in GlobalEvent reason union.
- agents.ts: `AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND === "1"` branch in `makeFakeAgent` (mirror the session-died branch).
- toasts.ts + App.tsx: `toastUnknownCommand` + reason branch.
- Acceptance: `bun run typecheck` green; existing suite untouched-green.

## 5. Work breakdown — tests (one wave, two tasks, disjoint files)

- **TT1** — new `src/bun/claude-tmux-unknown-command.test.ts` (style of `claude-tmux-death.test.ts` + `claude-tmux-scraper.test.ts`): matcher positives (with/without `●` bullet, args line present), negatives (token mismatch, mid-pane quoted text outside the tail window, no token armed); `signalUnknownCommand` in-flight settles + emits sentinel + preserves timers; idle no-op; reattach `onEndOfTurn` path; arming/clearing semantics.
- **TT2** — extend `src/bun/orchestrator-blocked.test.ts`: with fake driver + `AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND=1` assert column `blocked`, run `failed`, GlobalEvent reason `"unknown-command"` (mirror existing api-error/session-died cases).

## 6. Execution waves

1. Wave A: T1 (implementation) → typecheck + suite → commit.
2. Phase 5: code review (opus) on `git diff a1911e2...HEAD`.
3. Wave B: TT1 ∥ TT2 (disjoint files) → run suite (haiku) → fix loop ≤3 rounds → commit.

## 7. Blast radius & risks

- `scrapeOnce` runs on every claude session — matcher must be cheap and only run when armed (`pendingSlashToken !== null`).
- The reattach path sets `onEndOfTurn` — `signalUnknownCommand` must fire it like `signalSessionDeath` does; but `pendingSlashToken` is in-memory, so post-restart re-detection is impossible (see limitation L2).
- Do **not** clear scrape/death timers on fire — next turn reuses the live session (a follow-up send routes through `sendTurn` normally since the session exists).
- The fold-while-busy case (`pasteFollowUp`) races the 800ms `END_TURN_IDLE_FIRE_MS` idle-fire: the staged end_turn may resolve the run (→ review) before the ~1-2s scraper tick sees the error (limitation L1). When the scraper wins, the guard set (armed + in-flight) behaves correctly.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: Detection (→ blocked) is wanted, not prevention (escaping the `/`), since legitimate slash commands must keep working. This matches the task wording ("catch this kind of error and move the ticket to blocked").
- **A2**: Scope is the `Unknown command:` TUI error specifically (the reported case). Other TUI-level errors (rate-limit banners etc.) are out of scope; the matcher/signal shape is extensible.
- **A3**: Run status on detection is `failed` (mirrors api-error/session-died exactly — zero new status plumbing).
- **L1** (limitation): the fold-while-busy race above — if the idle-fire wins, the run resolves to review and the swallowed message is only visible in the pane. Rare (requires sending a slash message while a turn is mid-flight) and non-destructive.
- **L2** (limitation): a crash in the window between sentinel emit and run settle loses the in-memory armed token; after restart the reattached run is not re-detected. Window is milliseconds; accepted.
