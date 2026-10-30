# Spike — cursor-agent ACP ask wire

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Binary | `cursor-agent` 2026.10.22-27dcf5f (`~/.local/share/cursor-agent/versions/2026.10.22-27dcf5f`) |
| Method | Static read of the installed bundle. No model call. |
| Verdicts | `CURSOR_ASK_FREEFORM = "unsupported"`, `CURSOR_ASK_RESUME = "follow-up"` |

## Wire

Stdio is newline-delimited JSON-RPC 2.0 (`JSON.stringify(msg) + "\n"` in `@agentclientprotocol/sdk@0.14.1`). `protocolVersion` is the number `1`.

`cursor/ask_question` is a JSON-RPC **request from the agent to the client** (`extMethod`). The client result is what the handler reads. It is nested, the same shape as ACP permission results:

| | |
| --- | --- |
| Method | `cursor/ask_question` |
| Params | `{ toolCallId, title?, questions: [{ id, prompt, options: [{ id, label }], allowMultiple }] }` |
| Answered result | `{ outcome: { outcome: "answered", answers: [{ questionId, selectedOptionIds }] } }` |
| Skipped result | `{ outcome: { outcome: "skipped", reason? } }` — missing reason becomes `"User skipped questions"` |
| Anything else | Treated as cancelled. Reason `"User cancelled"`. Send `{ outcome: { outcome: "cancelled" } }`. |

The handler then builds the protobuf tool result. Answered copies **only** `questionId` and `selectedOptionIds` into `AskQuestionSuccess`. Skipped and cancelled both become `result.rejected` with that reason. That conversion is inside the CLI. Agetor still sends the three ACP outcomes above.

`promptMarkdown` and `runAsync` are not copied onto the extension params. `prompt` is.

## Freeform — `unsupported`

`7096.index.js` `ask-question-handler` constructs the success protobuf as `new AskQuestionAnswer({ questionId, selectedOptionIds })`. It never reads `freeformText`. The file contains no `freeformText` and no `__freeform_other__`.

`__freeform_other__` is the interactive TUI's synthetic option (`5622.index.js`), not a branch in the ACP handler. Putting that id in `selectedOptionIds` would forward an id the model did not offer, and the typed text would still be dropped.

A custom-only submit therefore cannot reach the model. The answer route returns 400 and leaves the card up. Option picks still map to `selectedOptionIds`.

## Resume — `follow-up`

`session/load` (`loadSession`) replays completed turns as `session/update`s (`replayConversationHistory` → user text, assistant text, thinking, completed tool calls). It does not call `processPrompt` and does not send `cursor/ask_question`.

`session/resume` dispatches to `unstable_resumeSession`. The Cursor agent class does not implement that method, so the RPC is `methodNotFound`. Resume is `session/load` with the stored session id.

A blocked `cursor/ask_question` is an in-flight JSON-RPC request. It dies with the child. The next turn does not see it again. Submit and Skip on a rebuilt card send the next user message, and the card says the wait ended when Agetor restarted.

## Launch

One home per knob. `cursor-agent acp --help` lists only `-h`, but parent options are accepted after the subcommand (`--bogus` is rejected; `--model`, `--force`, `--sandbox`, `--trust`, `--mode`, `--resume`, `-p` are not). Acceptance is not consumption. The ACP server (`7096.index.js`) reads `options.force` and `options.resumeChatId` only. `resumeChatId` is set by `loadSession` from the RPC session id, not from argv `--resume`.

| Knob | Home |
| --- | --- |
| Working directory | Process cwd and `session/new` / `session/load` `cwd`. Not `--workspace`. |
| Prompt | `session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }` |
| Model | `session/set_config_option` `{ sessionId, configId: "model", value }` after new/load. Same string `cursorModelArg` builds today. Not argv `--model`. |
| Plan | `session/set_mode` `{ sessionId, modeId: "plan" }` |
| Ask | `session/set_mode` `{ sessionId, modeId: "ask" }` |
| Auto | argv `--force`. `agent-store` sets `isRunEverything` from `options.force`. Agent mode is the default; no `session/set_mode` call. |
| Sandbox | Not read. `sandboxOverride` exists only on the print/chat path (`8008.index.js`). Do not pass `--sandbox`. |
| Trust | Not read by the ACP server. The print-mode "Workspace Trust Required" exit is in the chat command, and the `acp` action applies `--trust` only when a Cursor worktree-setup path is set. Agetor does not use that setup. Do not pass `--trust`. |
| Resume id | `session/load` `{ sessionId, cwd, mcpServers: [] }`. Not argv `--resume`. Not `session/resume`. |
| Print / stream-json | Do not pass `-p` or `--output-format`. |

Argv is `cursor-agent acp`, plus `--force` when the task mode is `auto`, plus any `AGETOR_CURSOR_ARGS`. `initialize` is `{ protocolVersion: 1, clientInfo: { name: "agetor", version } }`. No `authenticate` call; a logged-out CLI fails `session/new` with auth required.

`session/new` returns `{ sessionId, modes, models, configOptions }`. That `sessionId` is `runs.cursor_session_id`. `session/load` returns modes/models/configOptions and keeps the id we sent. `session/cancel` is a notification `{ sessionId }`.

## Updates

`session/update` notification params are `{ sessionId, update }`. Variants this driver maps:

| update.sessionUpdate | Chunk |
| --- | --- |
| `agent_message_chunk` | `content: { type: "text", text }`. Contiguous deltas flush as one `assistant` chunk when a different update arrives or the prompt resolves. |
| `agent_thought_chunk` | Same text shape. Contiguous deltas flush as one `thinking` chunk. |
| `tool_call` | `toolCallId`, `title`, `kind`, `status`, `rawInput`. Ask rawInput is `{ _toolName: "askQuestion", title, questions }`. Plan rawInput is `{ _toolName: "createPlan", name, plan }`. Emit the pinned `tool_use` shapes below. `line_uuid` is `tool_call:<id>:started`. |
| `tool_call_update` | `status: "completed"` emits `tool_result` with `line_uuid` `tool_call:<id>:completed`. |
| `session/prompt` result `usage` | `{ inputTokens, outputTokens, cachedReadTokens?, cachedWriteTokens?, thoughtTokens?, totalTokens? }`. Map `cachedReadTokens` → `cacheReadTokens` and `cachedWriteTokens` → `cacheWriteTokens`. Emit `FX_USAGE_STATUS_PREFIX + { turn }` when any of the four pinned fields is a finite number. |

This build's `handlePrompt` returns only `{ stopReason: "end_turn" \| "cancelled" }`. It does not attach `usage`. The SDK also defines `sessionUpdate: "usage_update"` as `{ size, used, cost? }` (context window), and the Cursor presenter never emits it. Do not treat `usage_update` as token counts.

`stopReason: "end_turn"` settles the turn as success. `"cancelled"`, a killed child, or an ask that resolved `cancelled` does not.

Pinned tool_use for a question (also what `cursor/ask_question` emits, so a tool_call update with the same id dedupes on `tool_call:<id>:started`):

```json
{ "id": "<toolCallId>", "name": "askQuestionToolCall", "input": { "askQuestionToolCall": { "args": { "title": "", "questions": [] } }, "toolCallId": "<toolCallId>" } }
```

Pinned plan tool_use, the shape `detectCursorPlan` reads (`input.createPlanToolCall.args.plan`):

```json
{ "id": "<toolCallId>", "name": "createPlanToolCall", "input": { "createPlanToolCall": { "args": { "name": "", "plan": "" } } } }
```

Session id is reported from `session/new` (and echoed for `session/load`) via `onSessionId`. It is not a `session/update`.

## runAsync

The ACP query callback always `await`s `extMethod("cursor/ask_question", …)`. It does not read `args.runAsync`. The short-circuit that returns `result.async` without waiting is the TUI store (`requestAskQuestion` in `8008.index.js`), not this server. A `runAsync: true` call still blocks. Register one card and answer the live request.
