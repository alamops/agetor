# Spikes — OpenCode v2 server driver

Live facts the server driver (`docs/plans/opencode-server-driver.md`) and its docs rest on. All checks ran on 2026-11-02/03 against **OpenCode v2.1.3** (Homebrew), model `opencode-go/deepseek-v4.1-flash` on the owner's Go subscription, from throwaway scratch directories with plain `fetch` clients. Raw transcripts stayed in the session scratchpad (they contain real session ids and paths); the sanitized event orders are pinned as test constants in `src/bun/fixtures/opencode/fake-serve.test.ts` and as the `v2-http-*.jsonl` fixtures. Session ids below are placeholders.

## Why not ACP

`opencode acp` answers a second `session/prompt` on a session with an active prompt with
`{"code":-32603,"message":"Internal error: Session already has an active ACP prompt: ses_…"}` (twice, 5 s into a 25 s turn); the first turn is unaffected and the second message never reaches the model. Source: `packages/cli/src/acp/turn.ts` (FiberMap busy check). ACP does expose question elicitation (`clientCapabilities.elicitation.form`) and live child updates (`_meta["opencode/child-session-updates"]`), but no mid-turn input.

## Steering through the HTTP inbox

- `POST /api/session/{id}/prompt {"text":…, "delivery":"steer"}` (operation `session.prompt`, ~0.2 s) on a running turn is enqueued at once (`session.inbox.enqueued`) and delivered at the next step boundary (`session.inbox.delivered`); the model answers it in the same reply and the turn ends normally (exit 0 for `opencode run`). Verified twice on the shared service and once on an `opencode serve` started for the spike.
- `delivery:"queue"` runs a second loop after the first; the `run` client waits for it.
- A steer waits for the current tool call to finish (a 15 s `sleep` delays it).

## Server, auth, sessions

- `opencode serve --hostname 127.0.0.1 --port 0` prints `server listening on http://127.0.0.1:<port>`; with `OPENCODE_PASSWORD` set it prints no password. Auth is HTTP Basic, user `opencode`; every route, `/api/info` included, needs it.
- One server runs sessions in several directories at once (`POST /api/session {location:{directory}}`); later calls are scoped by the session.
- A session created by `opencode run` through the shared background service is readable and promptable on another `opencode serve` with the same HOME (same data dir).
- The client process can be killed mid-turn: the turn finishes inside the server, and a fresh client that knows only url, password and session id catches up (`GET …/message`, `GET /api/session/active`) and follows the rest. `tmux kill-server` on the server's tmux session ends the server and its tool children.
- **`OPENCODE_PASSWORD` reaches the environment of the shell tools the server runs** (`env | grep -c OPENCODE_PASSWORD` → `1` from a tool call). An approved agent command can therefore call the API — Ask mode is a consent prompt, not a sandbox (`docs/architecture/security.md`).

## Events and snapshots

- One global SSE stream, `GET /api/event`: `data:` frames only, first `server.connected`, `: heartbeat` every 15 s, no replay, no `Last-Event-ID`.
- A turn: `session.inbox.enqueued` → `session.execution.started` → `session.inbox.delivered` → steps (`session.step.started`, `session.text.*`, `session.reasoning.*`, `session.tool.input.*`, `session.tool.called`, `session.tool.success|failed`, `session.step.ended{cost,tokens}`, `session.usage.updated`) → `session.execution.succeeded|failed|interrupted`.
- **`GET …/message` never holds partial text**: a streaming text/reasoning part is `text:""` until its `*.ended` event, then the full text (polled every 120 ms during a long answer; the server applies no deltas to the stored message). An in-progress assistant message has no `tokens`/`finish`/`time.completed` until `step.ended`.
- 402 on an empty Zen balance: `session.step.failed` then `session.execution.failed`, both with `error:{type:"provider.quota", status:402, message:"Upstream request failed: Insufficient account funds"}`; no usage, no retry.

## Permissions and questions

- A session rule `[{action:"*",resource:"*",effect:"ask"}]` makes read, edit (the `write` tool is action `edit`) and shell ask (`permission.asked`); replies are `POST /api/session/{sid}/permission/{rid}/reply {decision:"once"|"always"|"reject", message?}`.
- **Reject with a message**: the tool fails with `permission.rejected` and the model continues. **Reject without a message**: `tool.failed{aborted}` → `step.failed` → `execution.interrupted{reason:"shutdown"}` — the turn stops.
- Questions arrive as `form.created{metadata.kind:"question"}`. `POST …/form/{fid}/reply {answer:{}}` (empty) → 204, the model continues ("you gave no answer"). `DELETE …/form/{fid}?message=…` → the tool fails with the message and the model continues. `DELETE` without a message → `execution.interrupted`.

## Reject, duplicate ids and cancelled children (r2 spike, 2026-11-03)

Checked live on 2.1.3 and in the bundled source (`strings` on the Homebrew binary).

- The permission reply handler is `reply === "reject" → message ? CorrectedError{feedback} : DeclinedError`. `{decision:"reject", message:""}` → 204, then `tool.failed{type:"aborted","The user declined this tool call"}`, `step.failed`, `execution.interrupted{reason:"shutdown"}` (same as omitting it). `message:" "` → `tool.failed{type:"permission.rejected", message:" "}` and the model continues in a new step; the provider only rewrites an exactly-empty error value. One reject also rejects every other pending permission of that session with the same message. The reply body is `{decision: once|always|reject, message?: string|null}` (no other field). A session rule with effect `deny` removes the tool from the model's tool list entirely; the shell tool's action name is `shell`.
- Prompt ids must start with `msg_` (else 400 `InvalidRequestError`). Re-posting the same id on the same session is idempotent: 200 with the original record, the text is delivered once (a replay after the turn went idle runs an empty execution unless `resume:false`). The same id on another session → 409 `ConflictError` "Prompt message ID conflicts with an existing durable record".
- `POST /api/session/{child}/interrupt` on a background subagent → child `execution.interrupted{reason:"user"}`, then the parent gets `session.inbox.enqueued{item:{type:"synthetic", payload:{text:"<subagent … state=\"cancelled\" …>\nSubagent cancelled\n</subagent>", metadata:{source:"subagent", childID, agent, state:"cancelled"}}}}` and a new execution. Interrupting the parent returns `{interrupted:false}` when it is idle and never touches its children. Subagent states: `completed`, `error`, `cancelled`.

## Interrupts, the inbox, rejects and child order (r3 spike, 2026-11-03)

Checked live on 2.1.3 against two `opencode serve` processes started for the spike (fresh random password each, `OPENCODE_DISABLE_AUTOUPDATE=1`, a scratch git repo as cwd; both killed and checked dead afterwards), model `opencode-go/deepseek-v4.1-flash`, agent `build`; 8 executions in all. Scripts `q1.ts`, `q2.ts` (`child` and `user` modes), `q3.ts`, `q6.ts` on the r2 client helpers. Times are relative to the first prompt, from each event's `created`.

- **Q1, one Reject declines the session's other pending requests, each with its own event.** With the rule `*`/`*`/`ask` the model made two parallel shell calls; `reject` with `message:" "` on the first → 204, then `permission.replied{reply:"reject"}` and `tool.failed{type:"permission.rejected"}` for the first, then the same pair for the sibling. `GET …/permission` is empty right after; a later reply to the sibling, a second reply to the first and `GET …/permission/{id}` all answer **404** `PermissionNotFoundError`. The turn continued (`execution.succeeded`, R1 holds). Only requests of the **same session** are declined: the binary's `Permission.reply` skips any other session's request, so a background subagent's request stays pending (read from the source, not run live with two subagents).
- **Q2, a child interrupted while the parent's execution is open, then the parent interrupted: no new parent execution.** The parent launched a background subagent (`sleep 45`) and ran `sleep 30` itself. Child interrupt → `C tool.failed aborted`, `P inbox.enqueued{type:"synthetic", metadata:{source:"subagent", childID, state:"cancelled"}, delivery:"steer"}` (published just before `C execution.interrupted`), then the parent interrupt → `P execution.interrupted{user}` with **no `inbox.delivered`** for the item. For the next 20 s nothing happened on the parent: the item stayed in `GET /api/session/{id}/inbox` and `/api/session/active` was `{}`. The next user prompt's execution delivered the parked synthetic **first**, then its own prompt.
- **Q2b, a steered user message pending when the parent is interrupted: the same.** `prompt{delivery:"steer"}` during the parent's `sleep 30`, then the interrupt → `execution.interrupted{user}`, no delivery, no new execution; the message stayed parked (20 s, inbox listing) and was delivered first in the next prompt's execution, where the model saw both. The interrupt was sent without `?resume=true`; the openapi documents that flag as resuming pending steering input, but it was not tried.
- **Q3, `GET /api/session?parentID=<id>` lists children by `time.updated`, newest first**, not by creation; a PATCH of a child's title moves it to the front, and `order=asc` reverses the order. The cursor is opaque base64 JSON `{parentID, anchor:{id, time:<updated>, direction}}`, a keyset on `updated`, so a child updated between page fetches can cross the page boundary and be skipped or listed twice. `cursor.next` is a string even on the last page; the page after it is empty. (No model turns: the children were created with `POST /api/session {parentID}`.)
- **Q4, a synthetic item reaches the message list only once delivered.** Then it is a `type:"synthetic"` message whose `id` is the `inboxID`, with `metadata:{source, childID, agent, state}` and `time.created` = the **delivery** time. A pending item is only in `GET …/inbox` (enqueue order, full `payload.metadata`). Message ids are not in time order (the synthetic's id sorts before an older `idle` record's yet is listed after it), so the input of an execution is rebuilt from the `user`/`synthetic` records after the last `idle` record, or from the inbox before delivery.
- **Q5, an item left pending by an interrupt is kept, not discarded.** No `session.inbox.cancelled` or other event; it is delivered first by the next execution any later prompt starts (seen for both the synthetic of Q2 and the user message of Q2b).
- **Q6, `DELETE /api/session/{id}/inbox/{inboxID}` on a parked item → 204 with an empty body and exactly one `session.inbox.cancelled{sessionID, inboxID}`.** The inbox is then empty, and the next prompt's execution delivers only that prompt; the deleted text never appears in the message list. The same DELETE answers **204 with no event** for an id already cancelled, one already delivered and an unknown one; a malformed id is 400 `InvalidRequestError` ("Expected a string starting with \"msg_\""), an unknown session 404 `SessionNotFoundError`. So the 204 alone proves nothing; only the event does.
- **Q7, a steer on an idle session starts an execution at once.** With `/session/active` `{}`, `prompt{delivery:"steer"}` → 200, then within ~10 ms `inbox.enqueued` → `execution.started` → `inbox.delivered`. An omitted `delivery` is `steer` as well.

Consequences for the driver: the hub keeps pending items until delivered or cancelled, not until an execution ends; `kill()` interrupts the root before the children; a Stop takes the turn's own parked steers back out of the inbox (only when the removal is confirmed) and requeues them as the next turn; the cancelled-child notice of agetor's own Stop is told apart by the input of the execution, not by its last trigger ([harness-opencode.md](../architecture/harness-opencode.md)).

## Subagents and wakes

- The `subagent` tool creates a child session (`session.created{parentID}`); child events carry only the child's id on the same stream.
- A background subagent that finishes after the parent turn ended wakes the parent: `session.inbox.enqueued{item.type:"synthetic", payload.metadata.source:"subagent"}` then a new `session.execution.started` on the parent.
