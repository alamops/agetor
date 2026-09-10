# Plan — Fix fx harness: surface Gateway rate-limit recovery, add Resume, default fx to Full access

| Field | Value |
| --- | --- |
| Date | 2026-09-09 |
| Source | `/implement fix fx.sh harness` — "runs in the terminal, not through Agetor, right after updating to fx v0.0.8" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | fix/fix-fx-harness |
| Base SHA | c652464 (release v0.1.7) |

## 1. Objective & success criteria

An fx task that hits the Vercel AI Gateway's free-tier rate limit must **look** rate-limited in Agetor — live progress while fx retries, a persisted explanation when fx gives up, and a one-click **Resume** once the limit clears — instead of an empty "Agent is working…" panel that ends in a bare `refused`. New fx tasks default to **Full access** so the auto-review denial loop (which burns the quota) is no longer the out-of-the-box path, and a held tool call tells the user how to fix it.

Done when:
1. During a 429 storm the panel shows fx's own line ("⚠ Rate limited · HTTP 429 · … · retrying request in 8s · attempt 5/10"), updating in place; CLI `agetor logs` prints the progress lines; the TUI shows the latest one.
2. When fx pauses (10/10 attempts) the transcript keeps one persisted line explaining it, the run is `failed`, the card returns to **Ready**, and a **Resume** button (webview), `agetor resume <id>` (CLI) and `r` (TUI detail pane) continue the paused response via `session/prompt` + `_meta.fx.continueRecovery: true` without re-sending the prompt.
3. `AGENT_OPTIONS.fx.modes[0]` is `yolo` ("Full access"); `CODE_PLAN_MODE.fx.code` is `yolo`; every picker/CLI default follows.
4. A tool call fx held with `reason: "review_unavailable"` produces one status line per run telling the user to switch to Full access or Ask.
5. Unit + endpoint + driver + CLI tests green; a new Playwright spec drives the notice → paused → Resume flow through the fake fx driver; one live smoke on the owner's account reproduces 429 → paused → Resume.

## 2. Context & constraints (Phase 1 evidence, live-verified 2026-09-08/09)

- **Installed app already has the 0.0.8 compat code.** `/Applications/Agetor.app` was built locally at 22:07 from the #219 tree (bundle contains `usage_update`/`agent_thought_chunk`/`fx-title`; Info.plist still reads 0.1.6). Not a missing-compat problem.
- **All four owner runs tonight died on HTTP 429** (`~/.agetor/fx-logs/{afb560c8,dc2a4d9a,0eeb2ba4,a63a01a4}.log`). Gateway body: `rate_limit_exceeded: Free tier requests on this model are rate-limited. Upgrade to paid credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.` The 22:08 run (mode `auto`) made 5 calls in 6 s (shell call held by the reviewer 403 → replan) then 429 ×10 → `prompt_finish outcome_kind=recovery_paused`; the three later runs got 429 on their first call and were cancelled after 1.5–2 min. The terminal run at 22:13 (`~/.fx/sessions/h2V23SH7iAbC`, same worktree) fit 4 calls / 46.7k tokens into a cleared window.
- **Request path is byte-identical** between Agetor and a terminal-spawned `fx acp` (fx-log diff, scratchpad `spikes/acp-probe/probe-empty.log` vs `a63a01a4.log`) — the 429 is server-side quota state.
- **Live repro** (`spikes/acp-probe/probe429.ts`, raw wire in `probe429.raw.jsonl`): 5 quick turns OK (~10.5k input tokens each even for a 27-byte prompt — fx's system prompt + tool schemas), 6th → 429; fx retried 10× with backoff 0.3/1/2/4/8/16/30/30/30 s (128 s), then `stopReason:"refused"`, `usage:{}`. Every retry re-spends ~11k tokens, so the window never clears while retrying.
- **fx streams retry progress over ACP and Agetor drops it.** `src/acp/prompt.zig sendModelRecoveryStatus` → `types.zig writeModelRecoveryInfoUpdate` (present in 0.0.7 AND 0.0.8) writes, per attempt (twice: with and without `delaySeconds`):
  ```json
  {"sessionUpdate":"session_info_update","_meta":{"fx":{"modelResponseRecovery":{"state":"active","kind":"auto_retry","cause":"rate_limited","action":"retrying_request","attempt":5,"attemptLimit":10,"delaySeconds":8,"durable":true,"message":"⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request in 8s · attempt 5/10"}}}}
  ```
  then `{"state":"paused","kind":"terminal_provider_error","cause":"rate_limited","action":"paused","requiredAction":"continue_later","attempt":10,"attemptLimit":10,"durable":true,"message":"⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts"}`; on success after retries `{"state":"recovered","kind":"auto_recovered","attempt":N,"attemptLimit":10,"durable":true,"message":"✓ recovered · succeeded on attempt N/10"}`; `"modelResponseRecovery":null` clears. `state` is `recovered` for kinds `auto_recovered`/`manual_recovered_without_fast`, `paused` for `terminal_provider_error`, else `active`. Causes: `rate_limited | network_interrupted | response_interrupted | provider_stream_timeout | provider_unavailable | system_resumed | authentication | request_limit_reached`. Agetor's `mapFxUpdate` `session_info_update` branch (`src/bun/fx-acp.ts:1347`) reads only `title`; `fx-acp-mapper.test.ts:617` pins the recovery shape as "legacy pre-0.0.8 … emits nothing" — that label is wrong.
- **Resume works from a fresh process** (`spikes/acp-probe/probe-resume.ts`): `initialize` → `session/resume {sessionId}` (replays history INCLUDING the `paused` update, before the resume response) → `session/prompt {sessionId, prompt: [], _meta:{fx:{continueRecovery:true}}}` → "OK", `recovered` update, `end_turn`. A second continue → `-32602 "No paused model response to continue"`. A NORMAL prompt on a paused session consumes the checkpoint (prompt.zig:752 closes the interrupted turn). Other validation errors (`-32602`): "Recovery continuation cannot include a new prompt", "This session does not support durable recovery".
- **Held tool calls arrive verbatim.** `toolUpdateContentText` returns the full model_output for held/denied results: `{"error":{"type":"tool_review_held","tool_name":"shell","message":"…","reason":"review_unavailable","held":true,…}}` (also `"type":"tool_permission_denied"` with `reason`). On this account fx's hard-wired reviewer `openai/gpt-5.6-luna` answers 403 → `reason=review_unavailable`, model told "The action did not run because safety review was unavailable…".
- **Existing house patterns to follow:** sentinel prefixes in `src/shared/types.ts` + `isInternalStatusSentinel` (the ONE predicate RunPanel/CLI/TUI consult); RunPanel's single-pass `usageByRunId/providerByRunId/titleByRunId` memo (~line 1443); pure lib `src/mainview/lib/fx-usage.ts`; fake fx driver scenarios in `src/bun/agents.ts` (`AGETOR_FAKE_FX_PERMISSION` / prompt marker); orchestrator `sendFxTurn → spawnFxTurnNow` (~3272) + `findLastFxSessionId`; `/tasks/:id/plans/:planId/approve` route with a synchronous in-flight claim; `api.approvePlan` (`retry: false`); CLI `answer.ts` + `usage.ts` + `index.ts` dispatch; TUI `useInput` keys (`g`,`m`,`s`,`x`) and `sentLines` pre-pass.
- Gateway limits are undocumented numbers (Vercel docs: "free tier requests are rate limited per model … 429, retry after a short wait").

## 3. Approach & key decisions

1. **Map the recovery channel, don't tail the log.** fx already tells the client everything over ACP; agetor keeps its "never reads `--log-file`" contract. (Evidence: §2 live repro.)
2. **One new internal sentinel, `FX_RECOVERY_STATUS_PREFIX = "fx-recovery: "`, JSON body `FxRecoveryPayload`** (spec below) — sibling of usage/provider/title. Suppressed from transcripts via `isInternalStatusSentinel`; RunPanel derives per-run state; CLI/TUI render progress from it. Every recovery update is persisted as a sentinel row (history is replayable), deduped only against an identical consecutive payload.
3. **Two visible, persisted plain status lines at the terminal transitions** — paused (`<fx message> — resume once the limit clears, or send a new message.`) and recovered (`<fx message>`) — emitted by the mapper (not during `session/resume` replay), so the transcript, `agetor logs` and the TUI all explain what happened after the fact. (Owner, grill Q2.)
4. **Replay-aware driver.** `session/resume` replays the paused update onto the NEW run. The driver flags `replaying` from sending `session/resume` until its response: sentinels still emit (state derivation stays right), summary lines don't. When a NORMAL prompt is sent on a session whose replay carried a `paused` update, the driver emits a `{state:"cleared"}` sentinel (fx consumes the checkpoint), so the Resume affordance can't reappear on a succeeded follow-up.
5. **Resume = a new run row in the same session, no user bubble.** `resumeFxRecovery(taskId)` reuses the fx follow-up spawn path (refactored into `spawnFxRun(task, taskId, turn)`) with `continueRecovery: true`; the driver sends `prompt: []` + `_meta.fx.continueRecovery`. Gated server-side: fx task, not archived, no in-flight run, latest run `failed` whose last recovery sentinel is resumable, a prior session id. fx's `-32602` messages surface verbatim. (Owner, grill Q4: in scope.)
6. **Paused turn → run `failed`, card → Ready** (unchanged settle path; owner, grill Q3). The `refused` status line is enriched to `fx turn ended: refused (response paused after N/M attempts — resumable)` when this run saw a non-replayed paused update.
7. **Default fx mode → `yolo` ("Full access")**: reorder `AGENT_OPTIONS.fx.modes` to `[yolo, auto, ask]`, `CODE_PLAN_MODE.fx.code = "yolo"`. Pickers/CLI/kind-switch reset all read `modes[0]` and follow. **`null` stored mode still spawns as `auto`** (`buildCommand`/fake path) — no silent escalation of existing rows. (Owner, grill Q1.)
8. **Held-tool guidance**: on a `tool_call_update` whose content JSON has `error.type ∈ {tool_review_held, tool_permission_denied}` and `error.reason === "review_unavailable"`, emit once per run (after the tool_result chunk) the plain status line `⚠ fx held this tool call — its safety reviewer (auto mode) is unavailable on this account, so tools can't run. Switch this task's mode to Full access (or Ask) to let tools run.` (Owner, grill Q1.)
9. **Fake driver parity** (`AGETOR_FAKE_FX_RECOVERY=1` / `FAKE_FX_RECOVERY_PROMPT_MARKER = "__agetor_fake_fx_recovery__"` / `continueRecovery` flag) so the whole flow is e2e-drivable without the account.
10. **Live smoke after green** on the owner's account (`zai/glm-5.3-flash`, yolo) against the dev data dir: five quick turns → 429 storm → observe sentinels + paused line → `agetor resume` → recovered.

### Shared spec (binding for every task)

```ts
// src/shared/types.ts — additive
export const FX_RECOVERY_STATUS_PREFIX = "fx-recovery: ";
export type FxRecoveryState = "active" | "paused" | "recovered" | "cleared";
export interface FxRecoveryPayload {
  state: FxRecoveryState;
  /** Verbatim fx enum tags (forward-compat: unknown values pass through). */
  kind?: string; cause?: string; action?: string; requiredAction?: string;
  attempt?: number; attemptLimit?: number; delaySeconds?: number; durable?: boolean;
  /** fx's own human label, verbatim ("⚠ Rate limited · HTTP 429 · … · attempt 5/10"). */
  message?: string;
}
// isInternalStatusSentinel(): also true for FX_RECOVERY_STATUS_PREFIX.
// AGENT_OPTIONS.fx.modes order: yolo ("Full access"), auto, ask. CODE_PLAN_MODE.fx = { code: "yolo", plan: "ask" }.

// src/shared/fx-recovery.ts — pure, no React/bun imports
parseFxRecoveryMeta(update: Record<string, unknown>): FxRecoveryPayload | null | undefined;
  // undefined: no `_meta.fx.modelResponseRecovery` key. null-valued key → {state:"cleared"}.
  // object → strings kept only when typeof string (non-empty), numbers only when finite;
  // `state` from the wire when one of active|paused|recovered, else "active".
parseFxRecoveryPayload(json: string): FxRecoveryPayload | null;   // sentinel body; same validation; null on garbage/no state
fxRecoveryNoticeText(p: FxRecoveryPayload): string;   // p.message, else "⚠ <cause label> · <action label> · attempt N/M" with fx's label words (rate_limited→"Rate limited", retrying_request→"retrying request", paused→"recovery paused", …), else "⚠ Recovering model response"
fxRecoverySummaryLine(p: FxRecoveryPayload): string | null; // paused → `${notice} — resume once the limit clears, or send a new message.`; recovered → notice; active/cleared → null
isFxRecoveryResumable(p: FxRecoveryPayload | undefined): boolean; // state === "paused" && (requiredAction ?? "continue_later") === "continue_later"
latestFxRecoveryByRun(events: ReadonlyArray<{ runId: string; stream: string; data: string }>): Map<string, FxRecoveryPayload>; // last sentinel per run wins (event order = array order)

// src/bun/agents.ts — AgentRunOptions gains `continueRecovery?: boolean` (fx-only); spawnAgent passes it to spawnFxViaAcp.
// src/bun/fx-acp.ts — FxLaunchOptions gains `continueRecovery?: boolean` (requires resumeSessionId); FxUpdateCtx gains
//   `lastRecoveryJson?: string`, `replaying?: boolean`, `replayedPaused?: boolean`, `lastRecovery?: FxRecoveryPayload`, `reviewHeldWarned?: boolean`
//   (threaded read+write through dispatchSessionUpdate exactly like lastTitle).
// Orchestrator: export async function resumeFxRecovery(taskId: string):
//   Promise<{ ok: true; runId: string } | { ok: false; status: 400 | 404 | 409; error: string }>
// Server: POST /tasks/:id/fx-resume → 200 {ok:true,runId} | {error} with that status. Authed, corsHeaders, archived → 400.
// Webview api.ts: resumeFxRecovery: (taskId: string) => Promise<{ ok: true; runId: string }>   ({ retry: false })
// CLI api-client.ts: resumeFxRecovery(taskId: string): Promise<{ ok: true; runId: string }>
// Fake fx driver (scenario "recovery", not continueRecovery), chunk order:
//   status "fx-provider: gateway" → (t≈5ms) sentinel active attempt 1/3 → (≈400ms) active attempt 2/3 delaySeconds 1 → (≈800ms) active attempt 3/3
//   → (≈1500ms) sentinel paused {state:"paused",kind:"terminal_provider_error",cause:"rate_limited",action:"paused",requiredAction:"continue_later",attempt:3,attemptLimit:3,durable:true,message:"⚠ Rate limited · HTTP 429 · fake gateway limit · recovery paused after 3/3 attempts"}
//   → status fxRecoverySummaryLine(paused) → status "fx turn ended: refused (response paused after 3/3 attempts — resumable)" → resolveDone(1)
//   active message shape: "⚠ Rate limited · HTTP 429 · fake gateway limit · retrying request[ in 1s] · attempt N/3"
// Fake fx driver (continueRecovery=true, any prompt): provider sentinel → (≈5ms) sentinel recovered {state:"recovered",kind:"auto_recovered",attempt:1,attemptLimit:3,durable:true,message:"✓ recovered · succeeded on attempt 1/3"}
//   → status "✓ recovered · succeeded on attempt 1/3" → (≈10ms) thinking "fake fx reasoning" → assistant "recovered answer" → emitFakeFxUsageAndTitle → status "turn complete" → resolveDone(0)
// Test ids: fx-recovery-notice (live), fx-recovery-paused (paused notice), fx-recovery-resume (button).
```

## 4. Work breakdown — implementation tasks

**Wave 1**
- **T1 — Shared contract.** Files: `src/shared/types.ts`, `src/shared/fx-recovery.ts` (new). Add the sentinel/payload/state types, extend `isInternalStatusSentinel` (+ its doc: four fx sentinels), implement every helper in the spec with doc comments, reorder `AGENT_OPTIONS.fx.modes` (hints: Full access = hands-off default; Auto = "fx's LLM auto-review resolves most tool calls; needs a Gateway account with access to fx's reviewer model — otherwise tool calls are held"), flip `CODE_PLAN_MODE.fx.code` and rewrite its comment. Acceptance: `bun run typecheck` green; helpers are pure and importable from `src/bun` and `src/mainview`.

**Wave 2** (all depend on T1; file-disjoint)
- **T2 — Driver.** File: `src/bun/fx-acp.ts`. (a) `session_info_update` branch: recovery mapping per §3.2–3.4 (sentinel with `lineUuid: fx:<runId>:<seq>`, dedupe vs `ctx.lastRecoveryJson`, summary line unless `ctx.replaying`, set `ctx.lastRecovery` when not replaying, set `ctx.replayedPaused` when a paused arrives while replaying; title logic unchanged and independent — an update may carry either). (b) `tool_call_update` branch: review-held guidance once per run (`ctx.reviewHeldWarned`). (c) `FxUpdateCtx`/`FxSessionState`/`dispatchSessionUpdate` threading. (d) `runFxTurn`: set `state.replaying` around `session/resume`; `continueRecovery` → validate `resumeSessionId` (else `failTurn("fx acp: continueRecovery requires a prior session id")`), send `{ sessionId, prompt: [], _meta: { fx: { continueRecovery: true } } }`, surface a `-32602` `rawMessage` verbatim on a continue turn; on a NORMAL prompt after `replayedPaused` emit the `cleared` sentinel before sending; enrich the `refused` line when `state.lastRecovery?.state === "paused"`. (e) Update the file header's facts list (recovery channel live since 0.0.7; replay behavior; continueRecovery). Acceptance: existing `fx-acp.test.ts`/`fx-acp-mapper.test.ts` still pass except the one test that pins the wrong "legacy shape" claim (leave it failing for TT2 to rewrite — note it in your report); typecheck green.
- **T3 — Spawn seam + fake driver.** File: `src/bun/agents.ts`. `AgentRunOptions.continueRecovery?: boolean` (doc: fx-only), pass to `spawnFxViaAcp`; fake path: `makeFakeAgent(..., { …, continueRecovery })`; new `FAKE_FX_RECOVERY_PROMPT_MARKER` export + `AGETOR_FAKE_FX_RECOVERY` env; the two fake scenarios exactly per spec (branch order: put the recovery branch next to the fx-permission branch; `continueRecovery` wins regardless of prompt). Import the helpers from `src/shared/fx-recovery.ts`. Acceptance: `agents.test.ts` green; typecheck green (orchestrator's use of the new field lands in T4 the same wave — coordinate only through the spec name).
- **T4 — Resume plumbing.** Files: `src/bun/orchestrator.ts`, `src/bun/server.ts`, `src/mainview/lib/api.ts`. Refactor `spawnFxTurnNow` → `spawnFxRun(task, taskId, turn: { line: string } | { continueRecovery: true })` (user echo + "resuming fx session …" only for `line`; for continue: status `resuming paused fx response in session <id8>…`, `prompt: ""`, `opts.continueRecovery: true`); `sendFxTurn`/`drainFxQueue` call it with `{ line }`. Add `resumeFxRecovery` with the gating in §3.5 (inline SQL like `findLastFxSessionId`: latest run by `started_at DESC`; last `status` event `LIKE 'fx-recovery: %'` for it, parsed with `parseFxRecoveryPayload`, `isFxRecoveryResumable`). Route `POST /tasks/:id/fx-resume` (object-style, `authed`, synchronous per-task in-flight claim like `approvalsInFlight`, 409 while claimed). `api.resumeFxRecovery` per spec. Acceptance: typecheck green; `orchestrator-fx.test.ts` green.
- **T5 — Webview.** File: `src/mainview/components/kanban/RunPanel.tsx`. Extend the single-pass memo with `recoveryByRunId` (`parseFxRecoveryPayload`, last wins). Live notice: when `latestRun?.status === "running"` and its payload `state === "active"`, render `<RecoveryNotice>` (amber: `text-warning bg-warning/10 border-warning/30`, `data-testid="fx-recovery-notice"`, text `fxRecoveryNoticeText`, `title` = full message) directly under `RunningIndicator` — thread it as a prop into the transcript component that renders `RunningIndicator`/`HoldingIndicator` (props interface ~line 4129). Paused notice: when `kind === "fx" && !archived && latestRun?.status === "failed" && !(task.runId && runActive) && isFxRecoveryResumable(recoveryByRunId.get(latestRun.id))`, render `<PausedRecoveryNotice>` (`data-testid="fx-recovery-paused"`, `bg-danger/10 text-danger`), text = `fxRecoverySummaryLine`, plus a `Button` "Resume" (`data-testid="fx-recovery-resume"`, disabled while busy) → `api.resumeFxRecovery(task.id)`; on error `setSendHint(err.message)`. No literal palette classes. Acceptance: typecheck green; both notices never render for non-fx kinds; raw `fx-recovery:` lines never reach the transcript (predicate already suppresses).
- **T6 — CLI + TUI parity.** Files: `src/cli/api-client.ts`, `src/cli/commands/resume.ts` (new), `src/cli/index.ts`, `src/cli/usage.ts`, `src/cli/commands/logs.ts`, `src/cli/tui/Dashboard.tsx`. `agetor resume <task-id>` (`cmdResume`: resolveTask → `client.resumeFxRecovery` → `▸ resuming paused fx response for <id8> (run <run8>)`; `--json` prints the response; errors propagate through the existing handler); help line + `usage.ts` entry; `logs.ts`: before the generic sentinel skip, render an `fx-recovery:` sentinel whose `state === "active"` as `c.yellow(fxRecoveryNoticeText(p))` (paused/recovered rely on the plain lines — do not double-print); `Dashboard.tsx`: `buildFxRecoveryLines(events)` pre-pass mirroring `sentLines` (only the LAST active sentinel per run gets text, others `null`) rendered yellow in `EventLine`; detail header hint `· ⚠ paused — press r to resume` when the newest run's last recovery is resumable and `task.column !== "running"`; `r` key → `client.resumeFxRecovery(selected.id)` → status `▸ resuming <id8>` / `! <message>`. Acceptance: `bun test src/cli` green; typecheck green.

**Wave 3**
- **T7 — Docs.** File: `CLAUDE.md`. In the fx bullet: the recovery channel (`_meta.fx.modelResponseRecovery`, live since 0.0.7, was mis-pinned as legacy), the `FX_RECOVERY_STATUS_PREFIX` sentinel (now FOUR suppressed fx sentinels), replay/cleared semantics, Resume (`POST /tasks/:id/fx-resume`, `_meta.fx.continueRecovery`, `agetor resume`, TUI `r`), review-held guidance, and the default-mode change (pickers default to Full access; `null` still spawns `auto`). Fix the "Defaults preserve hands-off behavior" paragraph accordingly. Surgical edits only.

## 5. Work breakdown — test tasks (Phase 6, one wave, file-disjoint)

- **TT1** `src/shared/fx-recovery.test.ts` (new) + `src/shared/types.test.ts` (extend): every helper in the spec, incl. `isInternalStatusSentinel` for the new prefix, modes order, CODE_PLAN_MODE.
- **TT2** `src/bun/fx-acp-mapper.test.ts`: rewrite the "legacy pre-0.0.8 shape emits nothing" test; add active/paused/recovered/null→cleared, consecutive-duplicate dedupe, `replaying` suppresses the summary line but not the sentinel and sets `replayedPaused`, title+recovery independence, review-held guidance once per ctx (both error types; other reasons don't warn).
- **TT3** `src/bun/fx-acp.test.ts`: fake ACP server scenarios `recovery` (server pushes 2 active + 1 paused updates then answers `refused` → sentinels, summary line, enriched refused line, `done` = 1) and `continue` (driver launched with `continueRecovery` → captured `session/prompt` params `{prompt: [], _meta:{fx:{continueRecovery:true}}}`; server answers `end_turn` after a `recovered` update) and `continue-rejected` (`-32602 "No paused model response to continue"` surfaces verbatim); `resume` scenario replaying a paused update then a normal prompt → `cleared` sentinel emitted, no summary line.
- **TT4** `src/bun/orchestrator-fx.test.ts` + `src/bun/fx-resume-endpoint.test.ts` (new, mirrors `fx-permissions-endpoint.test.ts`): `resumeFxRecovery` 404/400 (non-fx, archived, latest run succeeded, no sentinel)/409 (in-flight) and the happy path with the fake driver (new run row, `fxSessionId` carried, settles `succeeded`, card Ready→running→review); route status codes; modes[0] expectations.
- **TT5** `src/cli/resume.test.ts` (new, mock-client pattern from `files.test.ts`), `src/cli/logs.test.ts` (active sentinel prints yellow; paused sentinel suppressed), `src/cli/api-client.test.ts` (request shape).
- **TT6** `e2e/fx-recovery.spec.ts` (new): fake scenario via prompt marker; notice visible with "attempt" text while running; after settle: paused notice + Resume; raw `fx-recovery:` text absent from the transcript; click Resume → "✓ recovered" line, notice gone; New Task form with fx selected shows mode "Full access" selected by default.

**E2e applies** (UI→API→orchestrator→driver flow). Run recipe (Phase 1 finding, memory `reference_agetor_e2e_playwright`): `export PATH="$HOME/.bun/bin:$PATH"; bun install` if needed; `bun run typecheck`; `bun test`; e2e via `bun node_modules/@playwright/test/cli.js test e2e/fx-recovery.spec.ts` — the fixture boots a headless backend per worker with `AGETOR_FX_DRIVER=fake` and an fx stub binary; one Playwright run at a time. Live smoke (owner-authorized account): `AGETOR_DATA_DIR=$HOME/.agetor-dev bun run src/cli/index.ts daemon` (or `bun run dev`), `agetor add --agent fx --model zai/glm-5.3-flash --mode yolo --start`, five quick `agetor send`, watch `agetor logs --json` for `fx-recovery:` sentinels → paused line → `agetor resume`.

## 6. Execution waves

1. Wave 1: T1 (alone — everything imports it). Checkpoint: typecheck + `bun test src/shared`.
2. Wave 2: T2, T3, T4, T5, T6 in parallel (disjoint files; cross-file names pinned in the spec). Checkpoint: typecheck + `bun test`; commit.
3. Wave 3: T7 docs. Commit.
4. Phase 5 review → Phase 6 tests (TT1–TT6 in parallel) → Phase 7 run (unit + e2e + live smoke) → Phase 8 fixes.

## 7. Blast radius & risks

- `isInternalStatusSentinel` gaining a prefix hides the new sentinel on all three surfaces at once (intended); old persisted events unaffected.
- `AGENT_OPTIONS.fx.modes` reorder changes `initialMode("fx")` (NewTaskForm/TaskLaunchPickers), `agetor add`'s default, `reconcileTaskSession`'s reset when switching INTO fx, and CODE_PLAN_MODE; stored modes on existing tasks are untouched; `null` still spawns `auto`.
- `session_info_update` now returns up to three chunks; `FxTextCoalescer` flushes on non-text chunks as before.
- `spawnFxTurnNow` refactor touches `sendFxTurn`/`drainFxQueue` only; run-row insert shape unchanged; no migration.
- Replay semantics on `session/resume` (paused update replayed) are spike-verified on 0.0.8 only; the `cleared` sentinel keeps a stale Resume from showing on a succeeded follow-up. A failed follow-up whose last sentinel is the replayed `paused` could still show Resume; fx answers `-32602 No paused model response to continue`, surfaced verbatim as the run's failure — accepted.
- Live smoke burns ~2–3 min of the owner's free-tier window; sequence it last.

## 8. Open questions / assumptions

- Grill answers (owner): Q1 Full access default + guidance line; Q2 live notice + persisted summary; Q3 paused → Ready/failed; Q4 Resume in scope.
- Assumption: fx keeps the checkpoint across `fx acp` process boundaries for `fx login` sessions (`durable: true` on every update; verified live once). If a future fx version drops it, Resume fails with fx's own `-32602` text — surfaced, not hidden.
- Assumption: the Gateway's 429 body may change wording; the UI shows fx's `message` verbatim, so nothing here parses it.

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| Recovery updates for causes other than `rate_limited` (network, provider, auth, sleep) | **In this run** — T1/T2 map every cause generically via fx's own message. |
| Replayed `paused` update on `session/resume` re-emitting the summary line / faking a resumable state | **In this run** — T2 `replaying` flag + `cleared` sentinel. |
| `refused` status line still bare after a pause | **In this run** — T2 enrichment. |
| CLI/TUI parity for progress, paused summary, and Resume | **In this run** — T6 (`agetor resume`, `logs`, TUI `r` + detail hint). |
| Fake-driver coverage so the flow is testable without the account | **In this run** — T3, TT6. |
| The test that mis-labels the recovery shape as legacy | **In this run** — TT2 rewrites it. |
| CLAUDE.md fx bullet and the "hands-off defaults" paragraph | **In this run** — T7. |
| Fleet knowledge: 0.0.8 dossier correction (recovery channel is live) + this root cause | **In this run** — orchestrator updates entries b4444a13 / c7a8ff0a after Phase 8. |
| Board-row (kanban card) hint for a paused fx task | **Out of scope** — needs a server-derived `Task` field; the run panel notice + TUI detail hint cover discovery. |
| Linkifying the Gateway "upgrade to paid credits" URL inside the notice | **Out of scope** — the message renders verbatim as text; a different ticket (notice markdown). |
| Auto-retrying a paused response on Agetor's side | **Out of scope** — fx already retries 10×; agetor retrying would re-spend the quota. |
| Changing `null` stored mode → `yolo` at spawn | **Out of scope by decision** — would escalate existing rows silently; pickers now default to Full access. |
| Owner-deferred | none |
