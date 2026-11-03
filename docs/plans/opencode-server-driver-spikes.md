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

## Subagents and wakes

- The `subagent` tool creates a child session (`session.created{parentID}`); child events carry only the child's id on the same stream.
- A background subagent that finishes after the parent turn ended wakes the parent: `session.inbox.enqueued{item.type:"synthetic", payload.metadata.source:"subagent"}` then a new `session.execution.started` on the parent.
