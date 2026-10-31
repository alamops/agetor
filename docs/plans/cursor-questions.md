# Plan — Cursor questions in the Claude ask card

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | `docs/plans/cursor-questions-investigation.md`, `docs/plans/cursor-questions-grill.md` (D1–D7) |
| Flags | none |
| Gates | Grilled by the owner (D1–D7). This plan is the contract for the Implementing step. |
| Branch | fix/cursor-questions |
| Base SHA | 0a2e636e26e85e85b5c8257e1646d58b7325cd03 |

## 1. Objective & success criteria

Cursor's `askQuestionToolCall` reaches the user as the same ask card Claude Code already uses (`kind: "ask_questions"`). The answer is the tool result: Agetor launches `cursor-agent acp`, implements the `cursor/ask_question` extension, and the process blocks until the user submits or skips.

A Cursor task still resumes its session, still detects a plan, and still records thinking and usage. Stop, archive, and delete clear the card. A question that is still open after an Agetor restart comes back, rebuilt from what was stored. The transcript shows the questions. Codex, OpenCode, and fx are not in this change.

Done when:

- A fake Cursor turn that asks a question shows the card, the board Answer button, and a structured tool block. Submit completes the turn with the chosen option ids. Skip completes it as skipped. A second question is a second card.
- The Claude scraper path is unchanged: same header, no Skip, keystroke delivery.
- A question with no stored resolution is registered again after the process that asked it is gone. The 21 historical `result.rejected` calls are not cards.
- `bun test` and `bun run typecheck` pass at every wave barrier. The new Playwright spec passes.

## 2. Context & constraints

Grounded in the investigation (cursor-agent 2026.10.22-27dcf5f) and the current code.

**What the user gets today.** `mapCursorEvent` turns a `tool_call` / `started` line into a generic `tool_use` (`src/bun/cursor-tmux.ts:313-341`). Nothing registers `ask_questions`, so `AskQuestionsCard` never mounts (`src/mainview/components/kanban/RunPanel.tsx:5653`, `:7827-7946`). Print mode rejects the question in tens of milliseconds with `Questions skipped by the user, continue with the information you already have`. All 21 stored results are that reject. The card cannot change that tool result on `cursor-agent -p`.

**The card and the route are Claude-shaped.** `AskQuestion` is `{ question, header?, multiSelect?, options: [{ label, description?, preview? }] }` (`src/bun/interactions.ts:65-80`). Answers are `{ selected: string[] /* labels */, custom?: string }` (`:109-115`). `POST /ask-questions/:id/answer` succeeds only when `source === "scraper"`, then drives tmux keystrokes or sends a follow-up (`src/bun/server.ts:6756-6863`). Any other id returns `{ ok: false }`. The route is already CLI-allowed (`src/bun/route-policy.ts:401`). The CLI and the TUI call it (`src/cli/commands/answer.ts:46-86`, `src/cli/tui/AnswerOverlay.tsx`). Pending `ask_questions` already drive the board Answer button (`src/mainview/components/kanban/TaskCard.tsx:106-109`), notifications (`src/bun/notification-hooks.ts`), and `agetor answer`.

**The Cursor driver is a one-shot tmux process.** `buildCommand` launches `cursor-agent -p --output-format stream-json` with `--model`, `--force --sandbox disabled` or `--mode plan|ask`, `--trust`, and `--resume` (`src/bun/agents.ts:717-772`). `spawnAgent` tails that log via `spawnCursorViaTmux` (`src/bun/agents.ts:3783-3818`). `spawnCursorTurnNow` mints a new run and passes `resumeSessionId` (`src/bun/orchestrator.ts:4887-4967`). `reconcileOrphans` reattaches a live cursor tmux session (`src/bun/orchestrator.ts:1011-1054`). `detectCursorPlan` runs when a cursor run succeeds and the last `tool_use` is named `createPlanToolCall` with `input.createPlanToolCall.args.plan` (`src/bun/orchestrator.ts:2983-3021`). Thinking is coalesced in `mapCursorEvent` (`src/bun/cursor-tmux.ts:270-288`). Usage is a `status` chunk prefixed with `FX_USAGE_STATUS_PREFIX` and a `{ turn }` body (`src/bun/cursor-tmux.ts:354-368`).

**ACP is the fx shape, not the tmux shape.** `fx acp` is a `Bun.spawn` child over stdio. There is no `reattachFxSession`. A `running` fx row at boot is orphaned (`src/bun/orchestrator.ts:999-1000`). fx permission cards are a real in-process promise (`registerFxPermission`, `src/bun/interactions.ts:587-627`). The Cursor ask extension, measured from the CLI bundle and not run live: the server calls `cursor/ask_question` with `{ toolCallId, title, questions: [{ id, prompt, options: [{ id, label }], allowMultiple }] }` and waits for `{ outcome: "answered", answers: [{ questionId, selectedOptionIds }] }`, or skipped, or cancelled. A permission-request fallback drops multi-select. D1 forbids that fallback. D5 requires multi-select.

**Two facts the bundle quote did not settle.** They are wave 0, not guesses in the driver:

- Whether `session/resume` or `session/load` re-issues a `cursor/ask_question` that was still in flight when the child died.
- Whether the answered payload accepts `freeformText`, the CLI's `__freeform_other__` option, or neither. The protobuf success result has `freeformText`. The ACP quote in the investigation has `selectedOptionIds` only.

**Call ids contain newlines.** Interaction ids are generated UUIDs, like the Claude card (`src/bun/interactions.ts:395`). The raw tool-call id is stored in SQLite and on the in-memory request. It is never a URL segment or a filename.

**Boot must not scan `run_events`.** A previous unindexed scan of that table froze the core on a large database. Pending questions live in a small table written at register time. The 21 historical rejects are absent from that table, so they are not rebuilt.

## 3. Approach & key decisions

Replace the production Cursor spawn with `cursor-agent acp`, modeled on `fx-acp.ts`: one piped child per turn, JSON-RPC over stdio, no tmux, no mid-turn reattach. The next turn resumes via the ACP session id already stored on `runs.cursor_session_id`. Plan detection, thinking, and usage stay on the chunk shapes they already read. The ACP mapper emits those shapes. `detectCursorPlan` is not rewritten.

The ask card stays `kind: "ask_questions"` with a new `source: "cursor"`. Claude keeps `source: "scraper"`. The Cursor entry has a real promise, like fx. The answer route branches on `source` and never plans keystrokes for a Cursor id.

| Decision | Choice | Why |
| --- | --- | --- |
| Delivery | ACP `cursor/ask_question` | Owner D1. Print mode cannot accept an answer. |
| Scope | Cursor only | Owner D2. |
| Card lifetime | Until answered, skipped, stopped, archived, or deleted, including after restart | Owner D3. |
| Skip | ACP `skipped` while the child is blocked. Not a user-message follow-up on that path. Stop, archive, and delete cancel the run and persist `cancelled`. They do not send `skipped`. | Owner D4. |
| Options and custom text | Existing radios, checkboxes, and Custom answer field. Labels on the card, option ids on the wire. | Owner D5. |
| Transcript | Structured title, prompts, and options. The block does not ask. | Owner D6. |
| Kind and copy | Same `kind`. Header is "Cursor is waiting" while the child is blocked. No "already continued" copy. No feature flag. One card per tool call. A second call does not replace the first. Question text is `prompt`, or `promptMarkdown` when `prompt` is empty. Show `args.title` when set. | Owner D7. |
| Where the pending question is stored | New table `cursor_asks`, written when the card is registered | Avoids a `run_events` scan at boot. Historical rejects are not rows. |
| Restart delivery | Whatever wave 0 records. If resume re-issues the request, Submit and Skip complete that request and the header stays "Cursor is waiting". If it does not, Submit and Skip send the next user message and the header says the wait ended when Agetor restarted. | Owner's fallback, already decided. The spike only selects which branch ships. |
| Custom text on the wire | Whatever wave 0 records: `freeformText`, or `__freeform_other__` plus the text. If neither, a custom-only submit is refused and the card stays up. Option picks still work. | "Not a silent drop." See §8. |
| `cursor-tmux.ts` | Stays. The fake stream and `mapCursorEvent` tests still use it. Production spawn stops calling `spawnCursorViaTmux` and `reattachCursorSession`. | Deleting the old host is a cleanup ticket. |
| Permission-request fallback | Not implemented | D1 and D5. A missing extension advertisement is a driver bug, not a second UI. |

**Pinned types** (wave 1 writes them; later waves only call them):

```ts
// src/shared/cursor-ask-verdict.ts — wave 0 only. Later tasks import, never edit.
export const CURSOR_ASK_FREEFORM: "freeformText" | "freeformOther" | "unsupported";
export const CURSOR_ASK_RESUME: "restores-request" | "follow-up";

// src/bun/interactions.ts
source?: "scraper" | "cursor";
title?: string;
toolCallId?: string;
delivery?: "live" | "restart-followup";
// AskQuestion gains optional id; options gain optional id.

export type CursorAskAnswer =
  | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[]; freeformText?: string }> }
  | { outcome: "skipped" }
  | { outcome: "cancelled" };

// POST /ask-questions/:id/answer
// scraper: { answers } — unchanged
// cursor submit: { answers } — labels in, ids mapped on the server
// cursor skip: { skip: true } — no answers required
```

`questionText(prompt, promptMarkdown)` in `src/shared/cursor-ask.ts` returns `prompt` when it is non-empty, otherwise `promptMarkdown`, otherwise `""`. Plain text. The card, the CLI, and the transcript all use it.

Label mapping, same module: walk each question's options in order, assign a selected label to the first option with that label that is not yet used, and emit its id. A single-select custom answer clears `selectedOptionIds` and sets `freeformText` (the CLI TUI stores typed text that way). A multi-select custom answer keeps the picked ids and also sets `freeformText`. When `CURSOR_ASK_FREEFORM` is `"freeformOther"`, the picked ids stay and `"__freeform_other__"` is added for the custom text, with `freeformText` set to that text. When it is `"unsupported"` and `custom` is non-empty, the mapper returns an error and does not build an answered payload.

Restart follow-up text, only when `delivery` is `"restart-followup"`: Submit sends `formatAnswersMessage` (`src/bun/claude-questions.ts:692-704`) unchanged. Skip sends the CLI's own sentence `Questions skipped by the user, continue with the information you already have`. Neither message names Agetor. The card header carries the restart sentence.

Tool-use shape the driver emits, so `detectCursorPlan` and the transcript share one parser with historical rows:

```json
{ "id": "<toolCallId>", "name": "askQuestionToolCall", "input": { "askQuestionToolCall": { "args": { "title": "", "questions": [] } }, "toolCallId": "<toolCallId>" } }
```

`createPlanToolCall` chunks keep the shape `detectCursorPlan` reads at `src/bun/orchestrator.ts:2997-3008`. Usage stays `FX_USAGE_STATUS_PREFIX` plus `{ turn: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }`. Thinking stays one `thinking` chunk per block.

**Schema** (`081`, no alias — nothing has shipped this id):

```sql
CREATE TABLE cursor_asks (
  task_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  outcome TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (task_id, tool_call_id)
);
```

`outcome` null means unresolved. `answered`, `skipped`, and `cancelled` are the resolutions. `payload_json` is `{ title, questions }` after `questionText` has been applied. Rebuild selects `outcome IS NULL`.

Resolution is written in `interactions.ts` before the promise resolves. The driver then sends the RPC. A crash in that window does not bring the card back; the turn is dying anyway.

`runAsync: true` is still one card and still answers the live request. If wave 0 finds the CLI does not block on that flag, the driver does not register a card for that call and emits an ordinary tool block. That is the only branch.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T0 | Record the ACP wire the rest of the plan follows | `docs/plans/cursor-questions-spike.md`, `src/shared/cursor-ask-verdict.ts` | — | See wave 0 below. No other source edits. |
| T1 | Pure parse, question text, label-to-id map, transcript lines | `src/shared/cursor-ask.ts` | T0 | `questionText`, `cursorAskFromToolUse`, `cursorAskAnswersFromLabels`, and `cursorAskPlainLines` match the pinned rules. The mapper imports the verdict and is not edited again when the verdict is one of the three freeform values. |
| T2 | Pending-question table and db helpers | `src/bun/migrations/081_cursor_asks.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts` | — | Import `m081` and append `{ id: "081_cursor_asks", sql: m081 }` after `080`. No alias. Helpers: `insertCursorAsk` (INSERT OR IGNORE), `resolveCursorAsk(taskId, toolCallId, outcome)`, `listOpenCursorAsks()`. `db.ts` gains only those helpers. |
| T3 | Cursor ask registry: promise, source, skip, cancel | `src/bun/interactions.ts` | — | `registerCursorAskQuestions` assigns a UUID, stamps `source: "cursor"`, `toolCallId`, `title`, `delivery`, and `pipelineParentId`, inserts the row via T2's helpers, and returns a promise. Question text comes from T1's `questionText`. A second register for the same `taskId`+`toolCallId` returns the existing card. `answerCursorAsk` writes the outcome, then resolves. `cancelPendingForTask` resolves Cursor entries as `cancelled` and writes `cancelled`. Scraper entries stay no-op promises. `AskQuestion` and options gain optional `id`. |
| T4 | Webview pending type and skip call | `src/mainview/lib/api.ts` | — | `PendingAskQuestions` gains optional `source`, `title`, `toolCallId`, `delivery`, question `id`, and option `id`, matching the §3 request. Add `skipAskQuestions(id)` posting `{ skip: true }`. `answerAskQuestions(id, answers)` stays. |
| T5 | ACP driver: session, chunks, blocking ask, fake ask | `src/bun/cursor-acp.ts` | T0, T1, T3 | `spawnCursorViaAcp` speaks the spike's launch table. Session id reaches `onSessionId`. Assistant text, thinking (one chunk per block), usage, and `createPlanToolCall` use the pinned chunk shapes. `cursor/ask_question` emits the pinned `tool_use`, registers `delivery: "live"`, and replies only after the promise settles: `answered`, `skipped`, or `cancelled`. Cancelled does not settle the turn as success; `kill()` still ends it. A second RPC is a second card. `runAsync` follows the spike. `rebuildOpenCursorAsks()` registers each open row with `delivery: "live"` when `CURSOR_ASK_RESUME` is `"restores-request"`, otherwise `"restart-followup"`. It does not insert a new row. `spawnFakeCursorAsk` blocks the same way for the marker below. No real `cursor-agent` in unit tests. |
| T6 | Answer route: Cursor submit, skip, restart follow-up | `src/bun/server.ts` | T1, T3 | Scraper branch unchanged, including the in-flight 409 claim. Cursor `skip: true` calls `answerCursorAsk` with `skipped` and returns `{ ok: true }`. Cursor `{ answers }` maps labels through T1. On mapper error, 400 and the card stays. On success, `answerCursorAsk` with `answered`. When `delivery` is `"restart-followup"`, also `sendInput` the pinned message (answers or the skip sentence) and do not expect a live child. Unknown ids still return `{ ok: false }`. The route file's other handlers stay as they are. |
| T7 | Production spawn, orphan leftover tmux, rebuild at boot | `src/bun/agents.ts`, `src/bun/orchestrator.ts` | T5 | Cursor `buildCommand` follows the spike's argv column and does not pass `-p` or `--output-format stream-json`. `spawnAgent` calls `spawnCursorViaAcp`. The fake branch checks `__agetor_fake_cursor_ask__` (optional `:2` for two questions) before the plan and stream markers and returns `spawnFakeCursorAsk`. `reconcileOrphans` no longer reattaches cursor. A cursor row that still has `tmux_session` is killed with `killSessionByName` on that name, then orphaned. After the orphan pass, call `rebuildOpenCursorAsks()`. `spawnCursorTurnNow` still passes `resumeSessionId` and still writes `cursor_session_id`. The `tmuxSession` column stays populated for symmetry with fx (`src/bun/orchestrator.ts:2057-2061`). |
| T8 | Card copy, Skip, title, structured tool body | `src/mainview/components/kanban/RunPanel.tsx` | T1, T4 | Scraper header stays "Claude is asking" and gains no Skip. Cursor `delivery: "live"` says "Cursor is waiting". Cursor `delivery: "restart-followup"` says "Cursor's wait ended when Agetor restarted". `title` renders when set. Skip posts `skipAskQuestions` and does not require a selection. Submit still reviews then sends labels and custom text. `askQuestionToolCall` tool bodies render title, prompts, and options via T1, the way `AskUserQuestion` does at `:6735-6754`. Test ids: `ask-questions-card`, `ask-questions-skip`, `ask-questions-title`, `cursor-ask-tool-body`. |
| T9a | CLI and TUI Skip for a Cursor card | `src/cli/commands/answer.ts`, `src/cli/api-client.ts`, `src/cli/tui/AnswerOverlay.tsx` | T4 | `skipAskQuestions(id)` posts `{ skip: true }`, the body pinned in §3. `answerAskQuestions(id, answers)` stays, so `src/cli/cli-scope-daemon.test.ts` is not edited. `agetor answer` and the TUI overlay offer Skip only when `source === "cursor"`. Claude questions still have no Skip. |
| T9b | Plain-text questions in logs and the TUI | `src/cli/commands/logs.ts`, `src/cli/tui/Dashboard.tsx` | T1 | An `askQuestionToolCall` tool_use prints the lines from `cursorAskPlainLines` instead of only `▸ askQuestionToolCall`. Other tools stay one line. |
| T10 | Living architecture note | `CLAUDE.md` | T7 | Replace the cursor bullet at `CLAUDE.md:79` so it describes `cursor-agent acp` over stdio, no mid-turn reattach, the ask card, and session resume on the next turn. Update any other sentence in that file that states the current Cursor driver is tmux stream-json. Do not edit historical plans. |

### Wave 0 — what T0 must write

Read the installed `cursor-agent` the way the investigation did (the bundle, not a model call). Record the version. Write `docs/plans/cursor-questions-spike.md` with this table filled from the bundle, and set the two constants in `src/shared/cursor-ask-verdict.ts` to match.

| Capability | What to record |
| --- | --- |
| `cursor/ask_question` request and the three outcomes | Method name, params, result fields |
| Freeform | `freeformText` on the answered item, or `__freeform_other__`, or `unsupported` |
| Resume of a blocked question | `restores-request` if `session/resume` or `session/load` re-sends the pending extension request. `follow-up` if the dead child's request is gone. Static control flow is enough when it is conclusive. A live probe is allowed only when the bundle is ambiguous, and it is one question then a kill, not a tour. |
| Launch | One column for argv, one for the RPC (`session/new` / `session/prompt` / `session/resume` / `session/load`). Cover model, plan/ask/auto (force and sandbox), trust, resume id, and where the prompt goes. Each knob has one home. |
| Updates | The `session/update` (or equivalent) variants that carry assistant text, tool calls, thinking, usage, and the session id, and the field names to map onto the pinned chunks |
| `runAsync` | Whether the extension call still blocks. If it does not, say so. |

`CURSOR_ASK_FREEFORM` and `CURSOR_ASK_RESUME` are the only values later tasks branch on. T0 does not implement the driver.

## 5. Work breakdown — test tasks

E2e applies to the ask card, Skip, the board Answer button, and the structured tool block. Restart rebuild is not an e2e flow: the harness does not restart a worker backend mid-spec. That path is `listOpenCursorAsks` plus `rebuildOpenCursorAsks` in unit tests.

Run recipe: `bun test` and `bun run typecheck` at each barrier. E2e: `bunx playwright test e2e/cursor-ask.spec.ts`. Playwright starts Vite (`bun run hmr` on port 5173) and each worker gets a headless backend from `e2e/fixtures.ts`, which already sets `AGETOR_CURSOR_DRIVER=fake`. No live `cursor-agent` and no model call. Mirror the harness-enable setup in `e2e/cursor-stream.spec.ts`.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit | T1 | `src/shared/cursor-ask.test.ts` | Prompt versus promptMarkdown, duplicate labels, single-select custom clearing ids, multi-select custom keeping ids, each freeform verdict, plain lines for a title and two questions. |
| TT2 | unit | T2 | `src/bun/db-cursor-ask.test.ts` | Insert once, resolve, list only `outcome IS NULL`. A second insert does not clobber a resolved row. |
| TT3 | unit | T3 | `src/bun/interactions.test.ts` | Register, answer, skip, cancel, duplicate tool-call id, scraper path still has no awaiter. Cursor cancel writes `cancelled` and does not write `skipped`. |
| TT5 | unit | T5 | `src/bun/cursor-acp.test.ts` | Scripted JSON-RPC peer, no binary. Set `AGETOR_DATA_DIR` before importing the driver (`interactions.ts` pulls in `db.ts`). Ask blocks until `answerCursorAsk`. Skip and cancel send the matching outcome. Two requests, two cards. Thinking coalesces. Usage chunk and a `createPlanToolCall` chunk match the pinned shapes. Session id is reported. Fake marker blocks and then completes. |
| TT6 | integration | T6 | `src/bun/server-cursor-ask.test.ts` | Scraper answer still plans keystrokes (existing behavior, not a Cursor id). Cursor submit maps a label to an id. Skip posts `{ skip: true }`. Custom-only against `unsupported` is 400 and the card remains. Restart-followup submit calls the send path with `formatAnswersMessage` and does not require a live child. |
| TT9a | unit | T9a | `src/cli/tui/AnswerOverlay.test.tsx` | A Cursor card lists Skip. Choosing it posts the skip call. A scraper card does not list Skip. |
| TT9b | unit | T9b | `src/cli/logs.test.ts`, `src/cli/tui/Dashboard.test.tsx` | `askQuestionToolCall` prints the question and its options. A `Bash` tool_use is still `▸ Bash`. |
| TT7a | unit | T7 | `src/bun/agents.test.ts` | Every cursor argv assertion that expects `-p` and `--output-format stream-json` (from the test at `src/bun/agents.test.ts:900` through the cursor flag cases) expects the spike's argv column instead. Model, mode, force, sandbox, and trust still appear in whichever column the spike assigned. |
| TT7b | unit | T7 | `src/bun/orchestrator-cursor.test.ts`, `src/bun/reconcile.test.ts` | Fake ask marker leaves the run running until the card is answered, then succeeds. A second marker value registers two cards. A `running` cursor row at boot is orphaned, not reattached. `cursor_session_id` is still persisted on start. Edit `reconcile.test.ts` only where a cursor reattach assertion would fail; leave unrelated cases alone. |
| TTe2e | e2e | T6, T7, T8, T9b | `e2e/cursor-ask.spec.ts` | Create a cursor task whose prompt contains `__agetor_fake_cursor_ask__`. The card shows "Cursor is waiting", the options, the custom field, and Skip. The board card shows Answer. The tool block shows the question. Submit closes the card and the run finishes. A second spec with `:2` shows two cards at once. Skip closes the card. A scraper-free assertion: the header is not "Claude is asking". |

`cursor-tmux.test.ts` is not in this change. `mapCursorEvent` stays.

## 6. Execution waves

Each barrier is a green `bun test` and `bun run typecheck`. Tasks in a wave do not share files.

**Wave 0.** T0 alone. Later tasks import `src/shared/cursor-ask-verdict.ts` and do not edit it.

**Wave 1.** T1, TT1, T2, TT2, T3, TT3, T4, in parallel. T3 calls `insertCursorAsk`, `resolveCursorAsk`, and `questionText` using the signatures in §3, so it does not wait on T1 or T2 to start. Nothing in this wave changes Cursor's production spawn, so existing cursor tests stay on `-p`.

**Wave 2.** T5, TT5, T6, TT6, T8, T9a, TT9a, T9b, TT9b. The driver, the route, and the card exist. Production `spawnAgent` still calls `spawnCursorViaTmux` until wave 3, so `agents.test.ts` stays green.

**Wave 3.** T7, TT7a, TT7b. This is the cutover. The argv tests and the spawn switch land together.

**Wave 4.** TTe2e, T10.

No red barrier. The scraper route stays valid in wave 2. The `-p` assertions stay valid until wave 3, when TT7a rewrites them.

## 7. Blast radius & risks

- **Session resume, plan approval, thinking, and usage** move onto the ACP mapper. They regress if the mapper emits a different `tool_use` shape than `detectCursorPlan` reads, or drops the usage prefix. TT5 locks those shapes. A live `cursor-agent` smoke is not part of this plan.
- **Mid-turn restart** no longer reattaches a Cursor tmux session. A leftover `-p` process from before the upgrade is killed by name (`killSessionByName` on that row's `tmux_session`), then the run is orphaned and any open `cursor_asks` row is rebuilt. This is the fx tradeoff D1 accepted.
- **`POST /ask-questions/:id/answer`** must keep the `source === "scraper"` branch first. A Cursor id that falls through into `planAskAnswers` would send keystrokes into a session with no modal.
- **Double submit** uses the existing `askAnswersInFlight` claim for Cursor as well as scraper.
- **Follow-ups while a question is open** stay on `cursorTurnQueue` (`src/bun/orchestrator.ts:4867-4878`). The turn is still running, so the message waits. It does not answer the card.
- **Rollback** is reverting the spawn to `spawnCursorViaTmux`. The `cursor_asks` table can stay; an empty table is unused. No backfill.
- **`server.ts`, `orchestrator.ts`, `agents.ts`, `db.ts`, `interactions.ts`, `RunPanel.tsx`** are hot files. Each is owned by one task in the wave that edits it.
- **`run_events` line uuids** for tool calls stay `tool_call:<id>:started`. The id may contain a newline. That is legal in a TEXT column. Do not use it as a path.

## 8. Open questions / assumptions

Wave 0 closes the two grill questions. The branches below are already specified so implementation does not invent a third behavior.

| Question | Proceeding on | Source | Confidence |
| --- | --- | --- | --- |
| Does ACP resume re-issue a blocked `cursor/ask_question`? | T0 sets `CURSOR_ASK_RESUME`. `restores-request` completes the new request. `follow-up` sends `formatAnswersMessage` or the CLI skip sentence, and the card says the wait ended when Agetor restarted. | Grill fallback | High that one of these two is right. Which one is the spike. |
| Does the extension accept custom text? | T0 sets `CURSOR_ASK_FREEFORM`. `freeformText` or `freeformOther` is sent as the tool result. `unsupported` returns 400, leaves the card up, and still accepts option picks. The Custom field stays on the card. | Grill: not a silent drop. The 400 is the visible refusal. | Medium. Confirm in review if a hard stop was wanted instead of a 400. |
| `runAsync: true` | One card, live RPC, unless T0 says the CLI does not block. Then no card, ordinary tool block. | Grill assumption | Medium |
| `promptMarkdown` | Plain text via `questionText`. Not rendered as markdown. | Unused on all 21 stored calls | High |
| Duplicate option labels | First unused option with that label, in order. | None of the 21 collided | High |
| Where argv flags go if the bundle is silent | T0's table is authoritative. Do not keep `-p` as a fallback. | D1 | High |

No one-way product choice is left open beyond those spikes. D1 (ACP instead of `-p`) is the one-way door, and the owner already took it.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Cursor driver moves from `cursor-agent -p` stream-json to `cursor-agent acp`, including session resume, plan approval, thinking, and usage | in this run | T0, T5, T7, TT5, TT7a, TT7b |
| `cursor/ask_question` registration, the ask card, and the answer route completing the RPC | in this run | T3, T5, T6, T8 |
| Skip as ACP `skipped`, including CLI and TUI | in this run | T6, T8, T9a, TT9a |
| Persist a resolution and rebuild an unresolved question after restart | in this run | T2, T3, T5, T7, TT2, TT7b |
| Structured `askQuestionToolCall` body in the webview, `agetor logs`, and the TUI | in this run | T1, T8, T9b, TT1, TT9b, TTe2e |
| Board Answer button, notifications, pipeline-parent stamp | in this run, no new UI | Same `kind`. `countPendingForTask` and `pipelineParentFor` already cover a new `ask_questions` row. TTe2e checks the Answer button. |
| Claude pane scrape, keystroke drive, `source: "scraper"` | out of scope | D7. T6 and T8 must leave that path in place. |
| Codex `request_user_input`, OpenCode `question`, fx `ask_user_question` | owner-deferred | Owner D2, later ticket |
| Gemini, Copilot, Antigravity question tools | out of scope | No binary was installed to verify (D2) |
| `switchMode` and other print-mode interaction rejects | out of scope | Not a question card (D2) |
| The 21 historical `result.rejected` calls as live cards | out of scope | They are not inserted into `cursor_asks` (D3) |
| Feature flag | out of scope | D7 |
| `@cursor/sdk` | out of scope | D1 is the CLI ACP server |
| ACP permission-request fallback | out of scope | Drops multi-select (D1, D5) |
| Deleting `spawnCursorViaTmux` / `reattachCursorSession` | out of scope | Production stops calling them. The mapper and `cursor-tmux.test.ts` stay. |
| Rewriting `docs/plans/cursor-sdk-integration.md` and `docs/plans/cursor-plan-approval.md` | out of scope | Those are the record of the old decision. `CLAUDE.md` is the living note (T10). |
| New route or `route-policy.ts` edit | out of scope | Skip is `{ skip: true }` on the existing POST. |
| Rendering `promptMarkdown` as markdown | out of scope | Plain text. None of the 21 calls set it. |
| E2e of a real process restart | out of scope | Covered by TT2 and TT7b. The Playwright worker does not restart its backend. |
