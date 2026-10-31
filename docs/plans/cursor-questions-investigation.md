# Investigation — Cursor questions in the Claude ask card

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Change | Surface Cursor's `askQuestionToolCall` through the same ask card Agetor already uses for Claude Code's `AskUserQuestion`, and decide how an answer gets back to the agent. This brief also records which other harnesses have a similar tool. |
| Agents | Inline (no subagents). Read of the cursor driver, the ask-card path, cursor-agent 2026.10.22, and the local `~/.agetor` DB. |
| Flags | none |

## 1. What we know

### What the user sees today

Cursor questions already arrive as ordinary tool events. `mapCursorEvent` turns a `tool_call` / `started` line into a `tool_use` chunk whose `name` is the inner key ending in `ToolCall`, and a `completed` line into a `tool_result` (`src/bun/cursor-tmux.ts:191-213`, `:313-341`). `askQuestionToolCall` therefore renders as a generic tool block. Nothing registers an `ask_questions` interaction, so `AskQuestionsCard` never mounts (`src/mainview/components/kanban/RunPanel.tsx:5653-5655`, `:7818-7888`).

The ask card itself is not Claude-shaped in the UI. It walks `questions[]` with radio/checkbox groups, a free-text custom field, and one submit. The server route is Claude-shaped: `POST /ask-questions/:id/answer` only succeeds when `source === "scraper"`, then drives tmux keystrokes (`planAskAnswers` / `driveAskAnswers`) or, as a fallback, Escapes the modal and `sendInput`s a follow-up (`src/bun/server.ts:6740-6863`). Any other id returns `{ ok: false }` (`:6861-6863`). The CLI and TUI call that same route (`src/cli/commands/answer.ts`, `src/cli/tui/AnswerOverlay.tsx`).

### Wire shape, measured

cursor-agent **2026.10.22-27dcf5f** (the build this repo already pins in `src/bun/cursor-tmux.ts:55-63` and `src/bun/agents.ts:725`). Agetor launches it as `cursor-agent -p --output-format stream-json` (`src/bun/agents.ts:725`, `src/bun/agents.test.ts:900-904`).

Protobuf schema in that build (`AskQuestionToolCall` / `AskQuestionArgs` / `AskQuestionResult`):

- `args.title` (string)
- `args.questions[]`: `{ id, prompt, options: [{ id, label }], allowMultiple, promptMarkdown? }`
- `args.runAsync` (bool), `args.asyncOriginalToolCallId` (string)
- `result` oneof: `success.answers[]` of `{ questionId, selectedOptionIds[], freeformText }`, or `error.errorMessage`, or `rejected.reason`, or `async`

Stream-json envelope matches every other cursor tool (confirmed against a live `readToolCall` / `grepToolCall` log and against the plan-approval captures): `{ askQuestionToolCall: { args, result? }, hookAdditionalContexts, toolCallId, startedAtMs, completedAtMs? }`. `call_id` contains an embedded newline, same constraint `docs/plans/cursor-plan-approval.md` already documents. Do not put the raw id in a URL or a filename.

The CLI's own TUI (not used by Agetor) always appends a synthetic option `{ id: "__freeform_other__", label: "Other" }`. If the model's last option label is "Other" or "Something else" (and a few prefixed variants), that option is hidden and the synthetic row replaces it. A picked Other with empty text is stored as `freeformText: "Other"`; typed text goes in `freeformText` and is **not** a `selectedOptionIds` entry. Footer in the TUI: `↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip`.

### Print mode does not wait

In `-p` / stream-json, the interaction listener writes an `interaction_query` request line, **immediately** rejects, then writes the response line. It does not read stdin. The reject reason hardcoded on that path is:

`Questions skipped by the user, continue with the information you already have`

A second, different string (`Questions skipped in headless mode`) exists on the subagent headless store. The print-mode path is the one Agetor hits.

`mapCursorEvent`'s default case drops unknown event types (`src/bun/cursor-tmux.ts:372-375`), so `interaction_query` never becomes a run event. The questions are still fully present on the `tool_use` chunk, which is enough to render a card. The `interaction_query` lines are a log of a decision the CLI already made.

There is no flag on `cursor-agent --help` that turns this into a blocking prompt. `cursor-agent acp` is a separate server. Its ask path **does** block: it calls the ACP extension `cursor/ask_question` with `{ toolCallId, title, questions: [{ id, prompt, options: [{ id, label }], allowMultiple }] }` and waits for `{ outcome: "answered", answers: [{ questionId, selectedOptionIds }] }` (or skipped / cancelled). A permission-request fallback exists for hosts that don't implement the extension, and it drops multi-select questions. Agetor does not speak ACP to Cursor. The Cursor driver is the stream-json one-shot clone of Codex (`docs/plans/cursor-sdk-integration.md` chose the CLI over `@cursor/sdk` so a restart can reattach).

### What production data shows

Read-only query of `~/.agetor/agetor.sqlite` on 2026-10-29:

- 21 `tool_use` events named `askQuestionToolCall`, and 21 matching `tool_result`s.
- All 21 results are `result.rejected` with the print-mode reason above. Zero `success`, `error`, or `async`.
- Zero of those 21 set `allowMultiple: true`, `promptMarkdown`, or `runAsync: true`. The schema still has all three; this user's calls simply didn't use them.
- On the sampled call, `completedAtMs - startedAtMs` was 57 ms. The reject is inside the CLI, done before Agetor's 150 ms log poll (`src/bun/cursor-tmux.ts:422`) can do anything about it.

So a card shown from the `tool_use` chunk cannot change that tool result. The model has already been told to continue without an answer.

### The card we would reuse

`AskQuestion` in `src/bun/interactions.ts:65-80` is `{ question, header?, multiSelect?, options: [{ label, description?, preview? }], hasTypeRow? }`. Cursor maps cleanly: `prompt` → `question`, `allowMultiple` → `multiSelect`, option `label` stays the label. Cursor option `id`s and `promptMarkdown` have nowhere to live on that type today. Answers are `{ selected: string[] /* labels */, custom?: string }` (`:109-115`), which matches the card and the CLI answer overlay. Cursor's successful tool result wants option **ids** plus `freeformText`. A follow-up message can speak labels; an ACP answer must speak ids.

Pending `ask_questions` already drive the board "Answer" button, the TUI overlay, `agetor answer`, notifications, and the pipeline-parent stamp (`pipelineParentId` on the request). A new registration reuses all of that if it is the same `kind`.

### Sibling harnesses

| Harness | Question tool | What Agetor does | Blocking? |
| --- | --- | --- | --- |
| claude-code | `AskUserQuestion` | Pane scrape + `AskQuestionsCard` + keystroke drive | Yes. The TUI modal waits. |
| cursor | `askQuestionToolCall` | Generic tool block | No. `-p` auto-rejects in tens of milliseconds. |
| codex 0.162.1 | `request_user_input` (also an app-server event next to `exec_approval_request`) | `codex exec` (`src/bun/codex-tmux.ts:34`). `mapCodexEvent` has no case for it (`:156-219`); unknown items become a generic tool. | No in exec mode. The binary says `request_user_input is not supported in exec mode` and `request_user_input requires an interactive stdin terminal`. Feature flag `experimental_request_user_input`. No real events in this DB (the hits were prose mentions). |
| opencode 2.1.3 | Built-in tool named `question` | One-shot `opencode run` (`src/bun/agents.ts:944`) | No. Non-interactive runs cancel with `This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them.` The tool prompt says a "Type your own answer" option is added automatically, and `multiple: true` allows multi-select. |
| fx 0.0.15 | `ask_user_question` | ACP (`src/bun/fx-acp.ts`). Permission prompts use `session/request_permission` and already have a card. | The binary says `ask_user_question is only available in the interactive shell; ask the user freeform instead`. Not the ACP permission card. |
| gemini, copilot, antigravity | Not checked against a binary | Those CLIs are not installed on this machine | Unverified. |

Cursor also auto-answers other interaction queries in print mode (`switchMode` is rejected on the headless paths in the same bundle). Plan approval is a different, already-shipped flow: `createPlanToolCall` **succeeds** and the run ends, then the user approves via a follow-up (`docs/plans/cursor-plan-approval.md`). A mode switch alone is not a question card.

## 2. What we proved

| Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does `-p` stream-json wait for an answer to `askQuestionToolCall`? | No | Print-mode `query()` writes `interaction_query` request, calls the auto-responder with reason `Questions skipped by the user, continue with the information you already have`, writes the response, returns. No stdin read. | cursor-agent 2026.10.22-27dcf5f | `8008.index.js` around the `askQuestionRejectReason` literal (offset ~559663) |
| Do real Agetor runs match that? | Yes | 21/21 `tool_result`s are that exact reject. Sampled call completed 57 ms after start. | Same CLI, `~/.agetor/agetor.sqlite` | SQL counts in this brief; no prompt text kept |
| Is the question payload on the event Agetor already stores? | Yes | `tool_use` `input.askQuestionToolCall.args` has `title`, `questions[].{id,prompt,options[].{id,label},allowMultiple}`, `runAsync` | Same | Redacted parse of one `tool_use` row |
| Can the existing answer route deliver a Cursor answer? | No | Route returns `{ ok: false }` unless `source === "scraper"`, then it plans Claude keystrokes | Repo | `src/bun/server.ts:6768-6863` |
| Does ACP block? | Yes, on `cursor/ask_question` | Extension method waits; fallback permission UI drops multi-select | Same CLI, `7096.index.js` ask-question handler | Not run live. Agetor does not launch `cursor-agent acp` |
| Codex / opencode / fx equivalents in headless? | They also do not wait | Strings quoted in §1 | codex 0.162.1, opencode 2.1.3, fx 0.0.15 | Not executed |

No scratchpad spike. The load-bearing behavior is in the installed CLI bundle and in 21 persisted results. A live `cursor-agent -p` turn would spend a model call to reconfirm a string we already matched 21 times.

## 3. What we're assuming

- The next Cursor CLI will keep the `*ToolCall` key, camelCase args, and the print-mode auto-reject. If a future CLI starts waiting on stdin for `interaction_query`, the follow-up-message design would race a real tool result and should be replaced by answering that protocol. Nothing in 2026.10.22 reads those lines back.
- Reusing `kind: "ask_questions"` is right if the owner wants the same card, the same Answer button, and `agetor answer`. A new kind would fork the card. Assumption: extend `source` (today only `"scraper"`) rather than add a kind.
- A follow-up message is a useful answer even though the tool result already says "skipped". The model is told to continue; the user's choices arrive on a later turn (queued if this turn is still running — `sendInput` already queues Cursor). If that is not good enough, the plan has to change the driver (ACP, or drop `-p`).
- `prompt` is the text to show. `promptMarkdown` was unused in all 21 calls. If both are ever set, the plan should say which one the card renders.
- Option identity for a follow-up message is the label. Duplicate labels would be ambiguous. None of the 21 calls had that problem. ACP delivery would use `id` instead.
- Gemini, Copilot, and Antigravity have no verified question tool here. Absence of a binary is not evidence they lack one.

## 4. What we must ask the owner

1. **How should the answer reach Cursor?** This decides the whole plan.
   - **Follow-up message (same card, current driver).** Register an `ask_questions` card from the `tool_use` args. Submit sends a user message with the picks (the Claude message-mode fallback is the precedent). The tool result stays the auto-reject. The model may already have moved on. This is the only option that does not replace `cursor-agent -p`.
   - **ACP, so the model waits.** `cursor-agent acp` blocks on `cursor/ask_question` and the tool result is the real answer. This replaces the stream-json driver (session resume, plan detection, thinking, usage). fx is the ACP precedent, but it is a different server.
   - **Interactive TUI, scraped like Claude.** Drop `-p`, drive the Ink form with keystrokes. Throws away the stream-json contract the Cursor driver is built on.
   Evidence: print mode rejects in ~57 ms and never reads an answer. The card cannot change that tool result on the current driver.

2. **When is the card live?** In-memory only, while the turn that asked is still running (Claude's model)? Or also after the turn settles, and again after an Agetor restart, rebuilt from the stored `tool_use` until the user answers or dismisses? Claude cards die with the process because the modal is gone. Cursor's question is already "answered" by the CLI, so a restart-surviving card is the only way a missed question is still askable. Dismiss ("skip") would close the card without a follow-up, since the CLI already skipped.

3. **Scope of the other harnesses.** Codex `request_user_input`, OpenCode `question`, and fx `ask_user_question` are the same product gap (headless auto-skip, no card) but different wire protocols. Recommend this change is Cursor-only, and the others stay a later ticket unless you want them in the same plan.

4. **Custom answer and multi-select.** The Claude card already has both. Cursor's TUI labels the free-text row "Other" and hides a model-supplied Other/Something else option. Should the card keep its "Custom answer" field as-is (and show the model's options unchanged), or mimic that Other-row rewrite? All 21 stored calls were single-select with no Other option; the schema still allows `allowMultiple`.

5. **Transcript rendering.** Besides the live card, should the `askQuestionToolCall` tool block in the message list render the questions (the way `AskUserQuestion` already gets a structured body in `RunPanel.tsx` around line 6735) instead of a raw JSON dump? That helps history. It does not, by itself, ask the user.

## 5. Completeness inventory

- Callers of the ask card (would pick up a Cursor `ask_questions` registration with no UI fork, once the answer route accepts it):
  - `AskQuestionsCard` — `src/mainview/components/kanban/RunPanel.tsx:5653`, `:7827`
  - Board Answer button — `src/mainview/components/kanban/TaskCard.tsx` (pending-interaction gate)
  - `POST /ask-questions/:id/answer` — `src/bun/server.ts:6756`; policy `src/bun/route-policy.ts:401` (`callers` include CLI)
  - `src/cli/commands/answer.ts`, `src/cli/tui/AnswerOverlay.tsx`, `src/cli/api-client.ts` `answerAskQuestions`
  - Notifications — `src/bun/notification-hooks.ts` (pending questions)
  - Cancel on teardown — `cancelPendingForTask` in `src/bun/interactions.ts`
- Cursor ingest path that would grow a detector:
  - `mapCursorEvent` tool_call case — `src/bun/cursor-tmux.ts:313`
  - Chunk handler that already special-cases `createPlanToolCall` — `src/bun/orchestrator.ts` `detectCursorPlan` (~2965-3005)
  - Fake driver hooks — `src/bun/agents.ts` `AGETOR_FAKE_CURSOR_PLAN` / `AGETOR_FAKE_CURSOR_STREAM` (~3246, ~3336, ~3802)
- Shape propagation if the request grows a Cursor `source` or option ids:
  - `AskQuestionsRequest.source` — `src/bun/interactions.ts:96-103` (only `"scraper"`)
  - `AskQuestion` — `:65-80` (no option id, no markdown)
  - `PendingAskQuestions` — `src/mainview/lib/api.ts:237`
  - Answer body — `{ selected, custom }` shared by webview, CLI, TUI
- Existing data: 21 historical rejected calls in `run_events`. No migration. They are not pending interactions. Rebuilding a card from them is a product choice (question 2), not a backfill.
- Docs that describe the current (wrong for this bug) behavior: `CLAUDE.md` cursor driver paragraph (stream-json, generic tool envelope); `docs/plans/cursor-plan-approval.md` (the sibling "turn ended, then the user acts" pattern); `docs/plans/cursor-sdk-integration.md` (why the driver is `-p`, not ACP, not the SDK); `docs/plans/askuserquestion-2-1-284-parsing.md` (Claude card only).
- What a Cursor card would not replace: Claude pane scraping (`src/bun/claude-questions.ts`, `collectAskQuestionsFromPane`). Leave that path alone.
- Orphans: none. Generic tool rendering stays the fallback for a call we fail to parse.

## 6. Runnability

- Start locally: `bun run dev:hmr` (Vite on 5173, API on 4318, data dir `~/.agetor-dev`). Desktop shell is Electrobun.
- Unit / integration: `bun test`, `bun run typecheck`. Cursor orchestrator tests use `AGETOR_CURSOR_DRIVER=fake`, `AGETOR_CURSOR_BIN=/bin/echo`, and `AGETOR_FAKE_CURSOR_PLAN=1` (`src/bun/orchestrator-cursor-plan.test.ts`). A question fixture belongs next to that hook.
- E2E harness: Playwright, `e2e/`, per-worker headless backend (`playwright.config.ts`, `e2e/fixtures.ts`). Applies if the card is user-visible. The fake Cursor driver can seed the tool call without a live CLI. A live `cursor-agent` smoke is optional and costs a model call.

## 7. Risks & blast radius

- Treating the card as if the CLI were blocked will lie to the user. The model has already been told to continue. Copy on the card has to say that the answer is sent as the next message, unless the owner picks ACP.
- `POST /ask-questions/:id/answer` is Claude-specific. A Cursor branch that forgets the `source` check would try to `tmux send-keys` into a print-mode session that has no question modal.
- Cursor `call_id`s contain newlines. Interaction ids must be generated (the Claude card already uses its own id), not the raw call id.
- Registering the card from a replayed log (reattach reads the log from offset 0) must be idempotent, or a restart mid-turn would stack duplicate cards. `line_uuid` is `tool_call:<call_id>:started`.
- `sendInput` while the asking turn is still running queues. That is desirable for a follow-up answer and is existing Cursor behavior. A withheld paste is a Claude concern; Cursor has no modal to withhold against.
- Plan detection keys off the last `tool_use` being `createPlanToolCall`. An ask call is a different tool. Don't let the ask detector run plan approval.
- Sibling harnesses are the same product gap and a different implementation. Folding them into this change multiplies the driver work (Codex exec protocol, OpenCode `question` tool, fx interactive-only tool).
- Rollback is "stop registering the card". No schema migration. Historical tool blocks stay generic if we don't also change transcript rendering.
