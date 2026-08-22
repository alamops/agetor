# Plan — fx branch finalization: correctness fixes, structural cleanup, docs truth, and the three sweep-ins

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Source | /implement "make sure everything is right and is the best we can do" — three-angle audit of the whole branch + owner grill |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled by owner (depth / fx default / README / sweep-ins answered); plan approval pending |
| Branch | feature/vercel-fx-sh-as-a-new-harness |
| Base SHA | dba536d (branch tip at plan time; 4 commits ahead of origin; tree clean) |

## 1. Objective & success criteria

Take the fx branch (11 commits: fx AgentKind over ACP + permission cards/plan/usage) from "works and reviewed twice" to "merge-ready and the best version of itself": every correctness finding from the integrated audit fixed, every stale/false statement in code comments and docs corrected, the driver restructured to sibling-driver proportion and testability, the test gaps closed, and the three previously-deferred items delivered (plan→TODO e2e, permission-card e2e, CLI answer path). Owner decisions: full depth incl. structural refactor; keep `DEFAULT_MODEL.fx = zai/glm-5.2-fast` with a documented exemption; README updated for fx **and** the already-missing cursor/gemini; all three sweep-ins in.

Done = typecheck clean; full `bun test` green (modulo the two known environmental flakes); Playwright green incl. the two new fx specs; opus review of this pass with no open must-fix; docs/plans cross-referenced and truthful.

## 2. Context & constraints (grounded by the three audits + the CLI/e2e map)

**Correctness (Audit A):**
- `CODE_PLAN_MODE.fx = {code:"yolo"}` (types.ts:1603) predates auto-becomes-interactive; every sibling has `code === modes[0].id === "auto"`. A Plan→Code pill round-trip on a fresh fx task escalates `auto`→`yolo` silently (NewTaskForm `onClickCode`).
- `fx-acp.ts` reaper is only `process.on("exit")` — does not fire on SIGINT/SIGTERM; no signal handlers exist anywhere in `src/bun/index.ts`/`quit-guard.ts`. Ctrl-C on `bun run dev` leaks a zombie `fx acp` with write access to a worktree agetor then flips to `ready`.
- `registerFxPermission` inserts into the registry **before** `broadcast(req)` and does not roll back on throw (orchestrator `emit` has no per-listener try/catch); driver's catch cleans its own maps but the registry keeps a phantom pending card forever (composer stuck disabled, badge inflated). Same latent hole in `registerScrapedAskQuestions`/`registerTmuxPrompt`.
- `isTimeoutError` regex-matches `"timed out waiting for"` on messages that include fx's own server-supplied error text → a Gateway timeout would be misfiled as `SESSION_DIED` → `blocked`.
- The model fallback "changed four agents" claim was **verified false**: at base `8a7e4b0` every kind threw `"model is required"` on a null model; the fallback converts a crash (stranded `running` row) into a default. Kept; it lacked a regression test and a CLAUDE.md note.
- `reattachKey`'s fx arm is dead (fx excluded from `canTryReattach`) with 10 lines of comment admitting it.
- `AnswerOverlay` arrow handlers compute `Math.min(-1, …)` on the fx dead-end; `answer.ts` prints the raw kind id.

**Stale truth / narration (Audits A+B):** `ask` described as auto-rejecting in `types.ts:1601-1602`, `NewTaskForm.tsx:905`, `docs/plans/fx-harness.md` §3.2; 9 build-process narration sites in `fx-acp.ts` (lines 7, 13-15, 122, 157, 198-199, 476, 489, 500, 905, 1088) + `045_fx_harness.sql:23` + `harnesses.test.ts:253` + `RunPanel.tsx:5866` + `e2e/fixtures.ts:206-209` + `Dashboard.tsx:329` (bogus `run-logic.ts` ref); `fx-acp.ts` header is ~174 lines (siblings 53–68) restating CLAUDE.md + plan + inline comments, settlement invariant copied 5×; `FxMode` comment blames "a parallel task"; CLAUDE.md: "Defaults preserve hands-off behavior" omits fx and is false for fx's `auto`; "Stop … funnels through `dropFxSession`" wrong (Stop = `cancelPendingForTask` + `cancelFxTurn`); `modalPending` rationale claude-only in RunPanel comment + CLAUDE.md §7; confirm-on-quit paragraph needs fx carve-out; "`/bin/echo` for the agent-status probe" untrue for fx (dual probe); orphan paragraph after the fx bullet; plan docs: fx-harness §2/§3.2/§3.4(20s vs 30s)/§3.6/§8 superseded; fx-acp-interactions `Gates` "pending", T3 "404" (code returns `{ok:false}`@200), §5 "e2e-proven via claude's cards" is **false** (no interaction card of any kind has e2e coverage).

**Structure (Audits A+B):** `pendingPermissionIds` is redundant with `cardIdByRequestId` (no await between add and respond on non-carded paths; carded ids are set synchronously) — the drain loop's non-carded `else` is unreachable; `respondRpc(cancelled)` literal ×9, yolo/fail-closed arms structurally identical; `errMessage` reimplemented inline at :434; fx is the only driver without an exported pure mapper (`mapCodexEvent`/`mapCursorEvent`/`mapGeminiEvent` exist) so every mapping test spawns a child; `waitUntilResolved` busy-polls 50ms instead of racing `done`; fake-server test source repeats the `setTimeout(ok(stopReason))` pair 12×; yolo test reimplements `permissionOutcomeFor`; `DEFAULT_MODEL.fx` sits under a comment asserting the flagship rule with no exemption note; 4 of 5 fx models lack `hint`; `FxPermissionRequest.mode` typed `string` vs documented `auto|ask`; `claude-tmux-queue.test.ts` uses positional `entries[2]/[3]`.

**Test gaps (Audit C):** `POST /fx-permissions/:id/answer` has zero HTTP tests; `POST /harnesses` kind=fx and `/agent-models` fx key untested over HTTP; fx plan→`tasks.todo_progress` persistence untested server-side; card-pending × queued-follow-up never exercised together; `isInternalStatusSentinel` untested; CLI fx copy/fallbacks untested; no e2e for any interaction card.

**Sweep-in ground truth (CLI/e2e map):**
- CLI: `answer.ts` loops pending and branches on kind (`answerAsk`/`answerTmux`), prints "skipping fx_permission" (lines 31-34); `AnswerOverlay.tsx` takes `pending[0]`, `optionLabels()` returns `[]` for fx, early-return copy at 173-176; `api-client.ts` has no `answerFxPermission` — add mirroring `src/mainview/lib/api.ts:1479-1483` (`POST /fx-permissions/:id/answer`, body `{optionId}` | `{cancel:true}` — HTTP key is `cancel`); `{ok:false}`@200 = already resolved (say so, not "failed"); `logs.ts:117-122` + `Dashboard.tsx:327-343` special-case fx to "answer in the app" — revert to the generic "agetor answer <id>" / "press g" copy once answerable; `AnswerOverlay.test.tsx` pattern = `fakeClient()` stub + `ink-testing-library` + `stdin.write(DOWN/ENTER)`; no `answer.ts` test exists.
- e2e: `fixtures.ts:210` sets `AGETOR_FX_DRIVER: "fake"` but not `AGETOR_FX_BIN` — fx's `checkHarness` dual-probes (`--version` + `--help` containing "coding agent"), so plant the stub from `orchestrator-fx.test.ts:22-41` synchronously before spawning `headless.ts`; fx harness seeds `enabled=0` → spec must `PATCH /harnesses/fx {enabled:true}` once per worker; task create with `agent:"fx"`, `isolation:"none"`, `workdir: tmpdir()`; `makeFakeAgent` is kind-agnostic and the existing `FAKE_CLAUDE_TODOS_PROMPT_MARKER` scenario already emits TaskCreate/TaskUpdate chunks for fx (badge `[title="0 of 2 tasks done"]` + `"2 tasks·0 done·2 open"` exact-punctuation text + `.getByText("0/2")`); a permission scenario needs a new `makeFakeAgent` arm gated on `AGETOR_FAKE_FX_PERMISSION=1 || prompt.includes(FAKE_FX_PERMISSION_PROMPT_MARKER)` that calls `registerFxPermission` (interactions.ts is a leaf module; `makeFakeAgent` must receive `runId`+`mode`), awaits the answer, emits `status "fake fx permission resolved: <optionId|cancelled>"`, and whose `kill()` resolves the card cancelled; RunPanel cards have no test ids — text/role selectors (`"Fx is requesting permission"`, `getByRole("button",{name: opt.name})`, literal `"Dismiss (reject)"`); per-task SSE drives the card; specs should be `serial`; the fx-permission scenario blocks until answered (Playwright timeout is the backstop).

## 3. Approach & key decisions

1. **Correctness first, behavior-preserving refactor second, tests last** — three waves with disjoint file ownership; the refactor wave is protected by the existing 25 driver tests + 11 orchestrator tests, and the test wave adds the missing coverage on top of the final shapes (so tests aren't written twice).
2. `CODE_PLAN_MODE.fx.code = "auto"` (Code pill returns to the hands-off-but-reviewed default, like every sibling; `yolo` stays an explicit picker choice).
3. **Signal reaping**: register `SIGINT`/`SIGTERM`/`SIGHUP` handlers in `fx-acp.ts` that SIGKILL `liveFxProcs` then `process.exit(128+signal)` — **only installed if no other handler for that signal exists** (`process.listenerCount(sig) === 0`) so a future app-level quit handler isn't shadowed; header claim softened to name what's covered. CLAUDE.md confirm-on-quit gets the fx carve-out.
4. **Registry rollback**: in all three `register*` functions, `try { broadcast(req) } catch (e) { map.delete(id); throw e }` — additive hardening of the same latent hole; claude's paths unchanged on the happy path.
5. **Driver refactor** (`fx-acp.ts`): (a) export pure `mapFxUpdate(update, ctx:{runId, nextSeq}) → Array<{stream,data,lineUuid?}>` with `extractText`/`toolCallName`/`toolCallInput`/`toolResultContent` beside it; `dispatchSessionUpdate` becomes a loop over it; (b) delete `pendingPermissionIds` and drive cancel/settle sweeps from `cardIdByRequestId` alone; (c) `respondCancelled(state,id)` + `answerByKind(state,id,options,kinds)` helpers; (d) `class RpcTimeoutError extends Error` thrown by `withTimeout`, `instanceof` check; (e) `waitUntilResolved` → `Promise.race([state.done, sleep(ms)])`; (f) header cut to ~50 lines: architecture (no tmux/no reattach/one process per turn/reaping), the settlement invariant **stated once** with the four inline sites reduced to a pointer, one-line-per-RPC protocol index with SPIKE/SCHEMA tags moved inline next to the calls; (g) all narration rewritten to contract language (exact replacements from Audit B items 1–8); (h) `FxMode` kept local with B's honest comment; tool_call comment moved to the fallback branch.
6. **fx default model**: keep `zai/glm-5.2-fast`; add the exemption sentence ("fx is exempt from the flagship rule: Gateway bills per token to the user's own account and fx's documented default is the tuned sweet spot for its agentic loop; flagship tiers stay in the picker") + hints for the other four models.
7. **CLI answer path**: `api-client.answerFxPermission`; `answer.ts` `answerFx()` (title/kind line, `p.select` over `options[].name` + trailing "Dismiss (reject)", `{ok:false}` → "already resolved"); `AnswerOverlay` fx arm mirroring tmux_prompt (labels = names + Dismiss; Enter submits; arrow guard on `labels.length>0`; shows `toolCall.title/kind`); delete the refusal early-returns; `logs.ts`/`Dashboard.tsx` revert to generic "agetor answer <id>"/"press g" copy; `answer.ts` copy no longer leaks the kind id.
8. **e2e**: plant fx stub bin in `fixtures.ts` (synchronously, before spawn) + `AGETOR_FX_BIN`; fix the fixture comment; new `e2e/fx-interactions.spec.ts` (serial): enable harness via PATCH once; (i) fx todo task using the existing marker → assert badge + pinned card; (ii) fx permission task using the new marker → assert card, click an option → assert echo status + card gone; (iii) dismiss path → "cancelled" echo. The fake permission scenario lives in `agents.ts` (`FAKE_FX_PERMISSION_PROMPT_MARKER`, `AGETOR_FAKE_FX_PERMISSION`), `makeFakeAgent` gains `{runId, mode}`.
9. **Orchestrator spawn-throw hardening**: wrap the six `spawnAgent(...)` seams so a synchronous `buildCommand` throw records the just-inserted run `failed` + returns the task to `ready` (mirrors the existing `if (!harness)` branch) — one small helper, not six copies.
10. **Docs**: CLAUDE.md fixes (defaults carve-out, Stop path sentence, modalPending rationale in §7, confirm-on-quit carve-out, `/bin/echo` clause, fold the orphan paragraph into the fx bullet, null-model fallback note); README: supported agents = five kinds, env-var table rows for cursor/gemini/fx; plan docs: `fx-harness.md` gets a "superseded in part by fx-acp-interactions.md" banner + §3.4 30s; `fx-acp-interactions.md` Gates → executed, T3 404→`{ok:false}`@200, §5 e2e sentence corrected; migration 045 + harnesses.test comments reworded to contract language (comment-only; branch unreleased).
11. **Scope held out**: interactions.ts `REGISTRIES` loop refactor (touches claude's shared paths for readability only); `fxSessionActive` (kept for sibling parity); any README rewrite beyond the agent list/env table.

## 4. Work breakdown — implementation

**Wave 1** (contracts + shared seams; disjoint):
- **T1** — owns `src/shared/types.ts`: `CODE_PLAN_MODE.fx.code = "auto"` + comment rewrite; lines 1601-1602 "rejected"→card wording; `DEFAULT_MODEL.fx` exemption sentence; `hint`s for the four fx models; confirm `AGENT_OPTIONS.fx.modes` hints already correct.
- **T2** — owns `src/bun/interactions.ts`: broadcast try/catch rollback in all three `register*`; `FxPermissionRequest.mode: "auto" | "ask"`; comment hygiene in the fx section (no narration; settlement-invariant paragraph reduced to a pointer to fx-acp.ts's single statement).
- **T3** — owns `src/bun/agents.ts`: `FAKE_FX_PERMISSION_PROMPT_MARKER` + `AGETOR_FAKE_FX_PERMISSION` gate; `makeFakeAgent` takes `{runId, mode}` (all five fake call sites pass them); new arm registers via `registerFxPermission`, awaits, emits echo status, `kill()` cancels the card; no other changes.

**Wave 2** (disjoint; after W1 commit):
- **T4** — owns `src/bun/fx-acp.ts`: the refactor per §3.5 + signal reaping per §3.3. Behavior-preserving; `bun test src/bun/fx-acp.test.ts` must stay 25/25 green before tests are rewritten (the pure mapper is additive; `dispatchSessionUpdate` delegates to it).
- **T5** — owns `src/cli/**` non-test files (`api-client.ts`, `commands/answer.ts`, `tui/AnswerOverlay.tsx`, `commands/logs.ts`, `tui/Dashboard.tsx`): CLI answer path per §3.7 + the comment/copy fixes.
- **T6** — owns `src/mainview/**`: `NewTaskForm.tsx:905` tooltip copy; `RunPanel.tsx` modalPending rationale comment extension; `RunPanel.tsx:5866` narration rewrite; mode badge typing follows T2 (string literal union flows through api.ts `PendingFxPermission.mode`).
- **T7** — owns `src/bun/orchestrator.ts`: delete dead `reattachKey` fx arm + trim comment + fold fx into the "sessions only live while in flight" sentence; spawn-throw hardening helper applied at the six seams (§3.9).
- **T8** — owns `e2e/**`: fixture stub bin + `AGETOR_FX_BIN` + comment; new `e2e/fx-interactions.spec.ts` per §3.8.
- **T9** — owns `CLAUDE.md`, `README.md`, `docs/plans/fx-harness.md`, `docs/plans/fx-acp-interactions.md`, `src/bun/migrations/045_fx_harness.sql` (comment-only): per §3.10.

**Wave 3** (tests; disjoint; after W2 commit + review fixes):
- **T10** — owns `src/bun/fx-acp.test.ts` + new `src/bun/fx-acp-mapper.test.ts` + `src/bun/interactions.test.ts`: move plan/usage/tool-pairing mapping assertions to pure `mapFxUpdate` tests (keep one child-spawn integration per family); fake-server `endTurn` helper dedupe; yolo test via `permissionOutcomeFor`; `RpcTimeoutError` classification test (fx error text starting "timed out waiting for" must NOT become SESSION_DIED); registry broadcast-throw rollback test; signal-handler registration test (handlers present; not installed when a listener already exists).
- **T11** — owns `src/bun/server-auth.test.ts` (or new `src/bun/fx-permissions-endpoint.test.ts`), `src/bun/orchestrator-fx.test.ts`, `src/bun/orchestrator.test.ts` (only if the spawn-throw helper test fits better there), `src/bun/harnesses.test.ts` (comment rewrite), new `src/shared/types.test.ts`, `src/bun/claude-tmux-queue.test.ts`: route tests (400 missing optionId / 400 unknown option / `{ok:false}` unknown id + lost race / `{ok:true}` success); `POST /harnesses` kind=fx; `/agent-models` fx key; fx todo_progress persistence via marker; card-pending × queued follow-up via the fake permission scenario through `sendInput`; model-null fallback regression (one claude, one fx); spawn-throw hardening (run failed, task ready); `isInternalStatusSentinel`; `CODE_PLAN_MODE[kind].code === AGENT_OPTIONS[kind].modes[0].id` for all kinds; predicate-based entry lookup in the tmux-queue test.
- **T12** — owns `src/cli/**/*.test.*`: `AnswerOverlay.test.tsx` fx cases (option submit, Dismiss → `{cancel:true}`, title/kind rendered, esc); new `answer.test.ts` if a CLI-command test harness pattern exists (else document why not); `Dashboard.test.tsx` fx row copy + sentinel suppression; logs `formatEvent` fx line if testable.

## 5. Test work breakdown

Unit/integration per T10–T12. **E2e applies** (new user-visible card flow + board badge): T8's `e2e/fx-interactions.spec.ts` via the per-worker headless backend and fake drivers — no credentials needed. Run recipe: `bunx tsc --noEmit`; `bun test`; `bunx playwright test` (auto-manages Vite + backends; serial describe for the fx spec).

## 6. Execution waves

W1 {T1,T2,T3} → commit → W2 {T4..T9} → commit → opus review → fix wave → W3 {T10,T11,T12} → commit → full run (unit + e2e) → fixes → report.

## 7. Blast radius & risks

- `interactions.ts` register rollback touches claude's card registration — additive try/catch; existing interactions tests guard. `makeFakeAgent` signature change touches all five fake call sites (compile-forced).
- Signal handlers in a module imported by tests — guarded by `listenerCount === 0`; tests that spawn the fake ACP child rely on SIGTERM to the child, not to the test process.
- Driver refactor is the riskiest diff — gated by the existing driver suite staying green before any test rewrite.
- Orchestrator spawn-throw helper touches all six seams — small, mechanical, tested.
- e2e fx spec blocks on card answer — Playwright timeout backstop; `serial` mode.

## 8. Open questions / assumptions

- A1: fx's real ACP option sets and `plan`/`usage_update` emission remain unverified without credentials (unchanged).
- A2: `FX_PERMISSION_MODE` efficacy over ACP unverified (unchanged; client policy is the backstop).

## 9. Completeness ledger

n/a — `--no-follow-ups` not active (but every previously-deferred item is now in scope by owner decision: CLI answer path → T5/T12; card e2e + plan e2e → T3/T8).
