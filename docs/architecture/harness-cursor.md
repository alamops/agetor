# Harness: cursor

> Moved from `CLAUDE.md`, where this was the `cursor` bullet of “Agent command shape”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

**`cursor`** → driven through `src/bun/cursor-acp.ts`.
Each turn is one `cursor-agent acp` child (plus `--force` when the mode is `auto`, plus `AGETOR_CURSOR_ARGS`) spawned with piped stdio via `coreSpawn` — no tmux, and no mid-turn reattach.
A restart orphans a `running` cursor row (a leftover `tmux_session` from the old driver is `killSessionByName`'d first) and rebuilds any open `cursor_asks` row as a card; the `tmuxSession` column is still written for symmetry with fx.
The prompt is `session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }`.
The model is `session/set_config_option` `{ configId: "model" }` with the string `cursorModelArg` already composed — not argv `--model`.
`plan` and `ask` are `session/set_mode`; `auto` is argv `--force` only and does not call `session/set_mode`.
A follow-up resumes with `session/load` of the `sessionId` stored on `runs.cursor_session_id` (`session/resume` is methodNotFound).
`session/load` replays the prior transcript as `session/update`s before its result; the driver drops every `session/update` until the `session/new` or `session/load` result line is seen (the gate opens on that line, so a later line in the same stdout chunk is live).
Argv never carries `-p`, `--output-format`, `--model`, `--mode`, `--sandbox`, `--trust`, or `--resume`.
The handshake is newline-delimited JSON-RPC and `initialize` sends `protocolVersion` as the **number** `1`.
Assistant text is one `assistant` chunk per coalesced `agent_message_chunk` block; thinking is one `thinking` chunk per coalesced `agent_thought_chunk` block.
Prompt-result `usage` becomes one `FX_USAGE_STATUS_PREFIX` `{ turn: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }` status sentinel (`cachedReadTokens` / `cachedWriteTokens` renamed on the way in; the SDK `usage_update` `{ size, used, cost? }` is not token usage).
On cursor-agent 2026.10.22-27dcf5f `session/prompt` returns only `{ stopReason }` and `presentInteractionUpdate` drops `turnEnded` (where print mode reads token counts), so the usage chip stays blank; the mapper still records `result.usage` when a later CLI attaches it.
A generic `tool_call`'s grown `rawInput` rewrites the `tool_call:<id>:started` row in place (`runs.replaceMainEventDataByLineUuid`) and re-emits the same line uuid; `completed` / `failed` emits `tool_result` (`tool_call:<id>:completed`) preferring `rawOutput`, then `content`.
Ask and plan keep their pinned `tool_use` and are not rewritten.
`session/request_permission` answers `{ outcome: { outcome: "selected", optionId: "allow-once" } }` (a killed turn answers `cancelled`) — `-32601` is a denial on this CLI.
`createPlanToolCall` chunks keep the shape `detectCursorPlan` reads.
`mapCursorEvent` in `src/bun/cursor-tmux.ts` stays for the historical stream-json fake (`__agetor_fake_cursor_stream__` / `AGETOR_FAKE_CURSOR_STREAM=1`) and is not the production driver.

**Questions:** `cursor/ask_question` blocks the turn and registers the same `ask_questions` card Claude uses, with `source: "cursor"`, header "Cursor is waiting" while the RPC is live (`ask-questions-title`).
When the cursor-agent process exits, `followupCause` is `"child-exit"` and that header becomes "Cursor's wait ended when the agent exited"; the `askQuestionToolCall` waiting line (`cursor-ask-waiting`) uses the same sentence instead of "Cursor is waiting".
`args.title` under it when set (`ask-questions-args-title`; `agetor answer` prints it once before the questions; the TUI overlay prints it above `Question N/M`), a Skip button, and the question rendered in the `askQuestionToolCall` tool block (`cursor-ask-tool-body`).
The tool result is the answer: option ids, not labels.
Two options that share a label are selected by id (`selectedOptionIds`); a label-only pick still binds the first unused option with that label.
Custom text is unsupported on this CLI (`CURSOR_ASK_FREEFORM`) — a custom-only submit is 400 and the card stays up; picking an option still works.
A restart cannot restore the blocked RPC (`CURSOR_ASK_RESUME` is `follow-up`): the rebuilt card's `followupCause` is `"restart"` and its header is "Cursor's wait ended when Agetor restarted", and Submit or Skip sends `formatAnswersMessage` or the sentence `Questions skipped by the user, continue with the information you already have` as the next user message before the outcome is written.
A live Skip completes the blocked RPC and does not report a message delivery.
If the child exits while that Skip is waiting, the card is already a `"child-exit"` follow-up, so the route sends the skip sentence before it writes `skipped` and only then reports `delivery: "message"`.
A refused send is 400 with no `delivery` field and the card stays registered.
Neither message names Agetor.
Stop, archive, and delete cancel the run and persist `cancelled`; they do not send `skipped`.
Fake seam: `__agetor_fake_cursor_ask__` (optional `:2` for two cards at once) is checked before the plan and stream markers.

**Mode mapping** (three modes): `auto` ("Auto (force)") → argv `--force` only; `plan` ("Plan") → `session/set_mode` `plan`, which backs the Code/Plan toggle (`CODE_PLAN_MODE.cursor = { code: "auto", plan: "plan" }`); `ask` ("Read-only") → `session/set_mode` `ask`; an unknown mode id gets `acp` and no `--force`.
ACP does not consume `--trust` or `--sandbox`.

**No effort flag** — effort is composed into the model id by `cursorModelArg`.
Ships **disabled by default** (migration `024` seeds the built-in row with `enabled=0`, house style per codex's migration 016) — enable in Settings.
Cursor has no config-dir env var — additional-account harnesses isolate via a full `HOME` override.
MCP servers are read from `<home>/.cursor/mcp.json` and the project's `.cursor/mcp.json` (the same `mcpServers` object as Claude's `.mcp.json`; a project row replaces a user row of the same name; `<home>` is an explicit harness-env `HOME`, otherwise `harness.home`, otherwise the process home).
Plugin-contributed servers and team-dashboard servers are not in those files.
Skills are discovered from `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.grok/skills`, `~/.agents/skills` and the same project-relative dirs, plus `~/.cursor/skills-cursor` built-ins (read from disk only) that lose to a same-named user or project skill.

**Plan approval**: cursor often ends a turn right after emitting `createPlanToolCall` (full plan markdown inline in `args.plan`; headless cursor-agent writes no plan file — `planUri` is always empty).
When a succeeded run's last `tool_use` is that tool, `detectCursorPlan` (orchestrator, at settlement) records a `pending` entry in the `tasks.plans` JSON column (migration 041, pure transforms in `task-plans.ts`); the RunPanel renders it as a plan card whose `PlanDialog` can edit (`PATCH /tasks/:id/plans/:planId`) and approve (`POST …/approve` — writes the effective plan to `<cwd>/.cursor/plans/<slug>_<id>.plan.md`, then auto-sends an approval message through `sendInput`; ask-mode tasks get the plan embedded in the message since they may not be able to read files).
A `plan`-mode task can never implement the plan in Plan mode, so approving it on an **unbound** task switches the task to `auto` through a direct `tasks.update` (never the PATCH route) right before the message goes out — reverted if the send throws or isn't delivered — and appends the status line `plan approved — switched this task to Auto (force) so cursor can implement it`; a **profile-bound** task keeps `plan` (its mode belongs to the profile), gets the plan embedded like an ask-mode task, and the status line plus an additive `warning` field on the response (`plan approved, but this task's agent runs cursor in Plan mode — detach the agent or switch the mode to implement`, which `PlanDialog` toasts).
Approve is guarded by a synchronous in-flight claim (double-approve would double-message the agent) and post-send persistence failures return `{ messageSent: true }`, which the dialog latches as non-retryable.
Test hook: `AGETOR_FAKE_CURSOR_PLAN=1` makes the fake cursor driver emit a plan turn (fresh call_id per turn, so a resumed turn exercises the supersede transition).
