# Plan — fx ACP interactions: permission cards, plan → TODO tracker, usage chip

| Field | Value |
| --- | --- |
| Date | 2026-08-21 |
| Source | /implement on the fx PR's "Future" follow-ups + owner grill answers |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner (modes/timeout/usage-UI answered); executed (commits afc074d…dba536d) |
| Branch | feature/vercel-fx-sh-as-a-new-harness (continues the pushed fx branch) |
| Base SHA | 5e56f75 (branch tip at plan time; tree clean) |

## 1. Objective & success criteria

Three fx-driver enhancements, all schema-grounded (canonical ACP schema.json) and codebase-seam-verified:

1. **Interactive permission cards**: an fx `session/request_permission` arriving in **ask or auto** mode (owner decision) surfaces as a RunPanel card showing the tool call (title/kind/rawInput when present) and fx's own option labels; the user's pick answers fx over JSON-RPC. `yolo` keeps auto-allow; unknown mode ids keep fail-closed auto-reject. **No timeout** (owner decision) — Stop remains the escape and answers `cancelled`.
2. **Plan → TODO tracker**: ACP `plan` snapshots (currently ignored) feed the existing TODO surfaces — pinned RunPanel card + board badge — via the legacy-`TodoWrite` event shape, with zero new UI.
3. **Usage chip**: latest `usage_update` (`used`/`size` tokens, optional `cost`) renders as a small chip on the run's summary row (owner decision), via the established status-sentinel + transcript-suppression pattern.

Done = typecheck green, full suite green, cards behave under cancel/Stop races, docs updated.

## 2. Context & constraints (grounded)

- **ACP shapes (schema.json, verbatim-verified)**: `plan` = full snapshot (`entries[{content, priority: high|medium|low, status: pending|in_progress|completed}]`, "client replaces the entire plan with each update"); `usage_update` = `{used: uint64, size: uint64, cost?: {amount, currency}}`, cadence unspecified ("MAY"); `request_permission` = `{sessionId, toolCall: ToolCallUpdate(only toolCallId required; title/kind/rawInput optional), options[{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}]}` answered `{outcome:{outcome:"selected", optionId}}` or `{outcome:{outcome:"cancelled"}}`; multiple requests may be pending ("all pending" in the cancellation clause); on `session/cancel` the client **MUST** answer all pending requests `cancelled`. fx additionally documents session-scoped approvals ("Allow for this session") — so cards must render fx's option **names**, not hardcode the four kinds.
- **Interaction subsystem (file:line-anchored by the map agent)**: in-memory registry `src/bun/interactions.ts` (never persisted to `run_events` — this is what keeps replay from resurrecting answered cards; the fx kind must keep that discipline). The `tmux_prompt` shape — `register → {id, req, answer: Promise}` + `answerX(id, answer)` — is the correct model for fx (a real in-process awaiter; claude's keystroke path has no fx analog). Broadcast bridge `wireInteractionBroadcast` (orchestrator.ts:478-525) fans `interaction`/`interaction_resolved` over SSE + global bus generically. `RunPanel.tsx`: `interactions` state bootstraps from `GET /tasks/:id/interactions/pending`, `modalPending = interactions.length > 0` is kind-agnostic (composer gating is free), cards dispatch from `renderInteraction`'s switch; `PendingInteraction` union lives in `mainview/lib/api.ts:227-229`. Stop path: `stopActiveHandle` → `cancelPendingForTask` before `kill()`.
- **TODO tracker**: `shared/todo-progress.ts` accepts legacy `TodoWrite` snapshots — `tool_use` data `{id, name:"TodoWrite", input:{todos:[{content, status?, activeForm?}]}}`, statuses `pending|in_progress|completed` (exact match with ACP's plan enum), full-list-replaces (exact match with ACP snapshot semantics). Orchestrator persistence (`maybeUpdateTodoProgress`) is kind-agnostic, triggered by the `"name":"TodoWrite"` substring. A synthetic chunk flows through **both** surfaces with zero UI/orchestrator changes.
- **Usage**: no per-run usage UI exists (harness quota topbar is a different concept). Established pattern: emit `status` chunk with a sentinel prefix, suppress it from transcript dividers (`RunPanel.tsx:3942` precedent), parse the latest into a chip on the run row (`RunPanel.tsx:3556-3564`, where duration/exit chips live) — exactly how the retired permission-mode chip worked.
- **Test seam**: `fx-acp.test.ts`'s scripted fake ACP server already sends real `session/request_permission` over stdio (`permission`, `cancel-permission-race` scenarios) — new scenarios extend it. `AGETOR_FX_DRIVER=fake` bypasses the driver entirely, so orchestrator-level fake tests don't exercise cards (fine; interactions.ts is directly testable).

## 3. Approach & key decisions

1. **Single source of truth for settlement.** Every card-mode permission settles through its interactions-registry promise: the driver registers (`registerFxPermission` → `{id, answer}`), awaits, then `respondRpc`s. All three settlement triggers resolve the *same* entry: (a) the user's card answer via `POST /fx-permissions/:id/answer`; (b) Stop → `cancelPendingForTask` (already called by `stopActiveHandle`/`deleteTask`) resolves it `cancelled`; (c) the driver's own `cancelFxTurn`/settle path calls `answerFxPermission(id, {cancelled})` instead of ever `respondRpc`ing directly for carded requests. The existing `pendingPermissionIds` delete-then-guard stays as the double-response backstop.
2. **Mode policy** (owner decision): `ask` + `auto` → card; `yolo` → auto-allow (`allow_once` preference unchanged); unknown/future ids → fail-closed auto-reject, no card. `cancelRequested || resolved` guard still short-circuits to `cancelled` before any card registers.
3. **Card payload**: `{toolCall: {toolCallId, title?, kind?, rawInput?}, options: [{optionId, name, kind}], mode}` — render fx's option `name`s verbatim (session-scoped options appear naturally); style reject-kind options as the non-primary action. Multiple concurrent cards allowed (registry + slots handle it).
4. **Plan mapping**: `plan` update → synthetic `tool_use` chunk `JSON.stringify({id: "fx-plan", name: "TodoWrite", input: {todos: entries.map(e => ({content, status, activeForm: undefined}))}, serverSide: false})`, line_uuid `fx:<runId>:<seq>` (each snapshot is a distinct event; most-recent-wins downstream). `priority` is dropped (TODO tracker has no priority concept) — recorded here as a known reduction.
5. **Usage mapping**: new sentinel `FX_USAGE_STATUS_PREFIX = "fx-usage: "` in `shared/types.ts` (house convention beside the other two); driver emits `status` chunk `prefix + JSON.stringify({used, size, cost?})` per update, line_uuid seq-based. RunPanel suppresses it from dividers and derives the latest per run for the chip (`45k/200k` + `· $0.42` when cost present).
6. **No timeout** (owner decision): a pending card holds the turn (fx blocks on the JSON-RPC response by design); the run stays visibly `running`; Stop cancels. No auto-reject timer.
7. **In-memory only**: the fx interaction kind is never written to `run_events` (replay safety); a mid-turn agetor restart kills the driver and the card dies with it (already-orphaned run — existing design).

## 4. Work breakdown — implementation

**Wave 1** (single task — the shared contracts):
- **T1** — owns `src/bun/interactions.ts` + `src/shared/types.ts`: `fx_permission` interaction kind (request/answer types, `registerFxPermission` returning `{id, req, answer: Promise<FxPermissionAnswer>}`, `answerFxPermission`, inclusion in `listPendingForTask` + `cancelPendingForTask` + broadcast paths); `FX_USAGE_STATUS_PREFIX` sentinel in types.ts.

**Wave 2** (parallel, disjoint; after W1 commit):
- **T2** — owns `src/bun/fx-acp.ts`: card-mode permission flow per §3.1–3.3 (async await of the registry promise, settlement unification, yolo/unknown-mode paths unchanged); `plan` → TodoWrite synthetic chunk (§3.4); `usage_update` → sentinel status chunk (§3.5); header-comment updates.
- **T3** — owns `src/bun/server.ts`: `POST /fx-permissions/:id/answer` (validate optionId against the pending request's options — mirror the tmux-prompt route's key validation — or `{cancel: true}`; resolve via `answerFxPermission`; `{ok:false}` at HTTP 200 for unknown/already-resolved — the tmux-route convention, not a 404 — with `400` reserved for validation failures: missing `optionId` and an `optionId` not in the pending request's option set).
- **T4** — owns `src/mainview/**`: `PendingInteraction` union + `api.answerFxPermission` (lib/api.ts); `FxPermissionCard` matching the existing card shell (tool title/kind, generic rawInput rendering, option buttons by fx's names, reject styled secondary) + `renderInteraction` case (RunPanel.tsx); usage: suppress `FX_USAGE_STATUS_PREFIX` from StatusDivider stream + run-row chip parsing latest usage from that run's events.

**Wave 3** (parallel, disjoint; after W2 commit):
- **T5 tests** — owns `src/bun/fx-acp.test.ts`, `src/bun/interactions.test.ts`, `src/bun/server-auth.test.ts` (only if route auth assertions live there — check): fake-server scenarios: ask-mode card (register → HTTP-style resolve via `answerFxPermission` → correct `respondRpc` outcome), auto-mode card, yolo unchanged auto-allow, Stop/cancel resolves card + answers `cancelled` (extend `cancel-permission-race` family), plan → TodoWrite chunk shape (+ derives via `deriveTodoProgress`), usage sentinel chunk shape + dedupe; update the now-obsolete "ask mode answers reject_once" test to the card flow (fail-closed reject still asserted for unknown modes).
- **T6 docs** — owns `CLAUDE.md`: update the fx bullet (permission cards, plan mapping, usage sentinel; RunPanel suppression note is load-bearing).

## 5. Test work breakdown

Covered by T5 (driver + registry + route). No new e2e spec at the time this plan executed: the e2e backend runs `AGETOR_FX_DRIVER=fake`, which bypasses the ACP driver, so cards couldn't be exercised end-to-end without a real ACP child in the e2e harness — recorded as out of scope. That "no e2e coverage" gap was real, not just for fx: no interaction card of any kind (claude's asks/tmux prompts included) had e2e coverage as of this plan. fx gains the first in `docs/plans/fx-branch-finalization.md`, via a fake-driver permission scenario (`AGETOR_FAKE_FX_PERMISSION`) exercised by `e2e/fx-interactions.spec.ts`. The CLI answer path (`agetor answer`, `AnswerOverlay`) was also out of scope here and was later swept into the same finalization plan. Run recipe: `bunx tsc --noEmit`, `bun test`, `bunx playwright test`.

## 6. Execution waves

W1 {T1} → commit → W2 {T2,T3,T4} → commit → review → W3 {T5,T6} → commit → full run → fixes.

## 7. Blast radius & risks

- `interactions.ts` is shared with claude's cards — T1 must be purely additive (claude flows untested-changed = regression risk; existing interactions.test.ts guards).
- Behavior change: **auto-mode** requests now stall awaiting a human instead of auto-allowing — owner explicitly chose this; surfaced in CLAUDE.md + the mode hint copy (T4 updates `AGENT_OPTIONS.fx.modes` auto hint? — types.ts is T1's file; T1 adjusts the auto/ask hints to mention cards).
- Race matrix (settlement single-sourcing in §3.1 is the mitigation): user answer vs Stop vs process death vs turn-end; double-`respondRpc` guarded by `pendingPermissionIds` delete-then-check.
- fx's real option sets are schema-derived, unverified live (no credentials) — card renders names generically, so unexpected option sets degrade gracefully.
- `plan`/`usage_update` cadence unknown — snapshot semantics make spam harmless (most-recent-wins; chip shows latest).

## 8. Open questions / assumptions

- **A1** (low): fx actually emits `plan`/`usage_update` over ACP (undocumented on fx's page; schema variants exist). If it never does, the mapping is dormant code with test coverage — no harm.
- **A2** (low): auto-mode requests are rare (fx's LLM review resolves most) — if live use shows spam, the owner can flip auto back to auto-allow in one policy line.
- Live verification still pending owner credentials (unchanged from the base PR).

## 9. Completeness ledger

n/a — `--no-follow-ups` not active.
