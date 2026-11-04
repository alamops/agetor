# OpenCode CLI fixtures

Captured on 2026-10-27 by Wave 0 (S0) of `docs/plans/add-opencode-harness.md`. Spike notes and the questions they answer: `docs/plans/add-opencode-harness-spikes.md`.

- **v2** = Homebrew `opencode` 2.1.3 (`opencode --version` → `opencode v2.1.3`).
- **v1** = npm `opencode-ai@1` 1.19.4 (`opencode --version` → `1.19.4`).
- Every probe ran with `HOME` and every `XDG_*_HOME` pointed at an empty scratch home, `OPENCODE_DISABLE_AUTOUPDATE=1`, no credentials. Models were the keyless OpenCode Zen free models (`opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`).
- Prompts went in on stdin (`< prompt.txt`). Unless a row says otherwise, v2 ran with `--standalone`.
- Sanitizing: the scratch project dir is rewritten to `/Users/test/project` and the scratch root to `/Users/test/scratch`. Nothing else was edited. Session, message and part ids are real. No file contains a credential. The v2 server password that `serve` prints was never saved.
- Files ending in `.txt` that come from v1 keep their raw ANSI escapes (`\e[91m\e[1mError: \e[0m…`). Strip them before matching.

Every file below is `captured` unless the row says otherwise.

| File | Line | Command (cwd = scratch git repo with `a.txt`, `b.txt`) | Notes |
| --- | --- | --- | --- |
| `v2-version.txt` | v2 | `opencode --version` | `opencode v2.1.3` |
| `v1-version.txt` | v1 | `opencode --version` | `1.19.4` |
| `v2-run-basic.jsonl` | v2 | `run --standalone --format json --thinking -m opencode/glm-5.3-flash-free` | step_start, reasoning, a `read` tool_use, step_finish, text, step_finish |
| `v2-run-tools-todowrite.jsonl` | v2 | same plus `--auto`, with `OPENCODE_CONFIG_CONTENT='{"experimental":{"todo":true}}'` | two `shell` tool_use events (one command exits 1, but status is still `completed`), `todowrite`, final text. **The last step has no `step_finish`.** |
| `v2-run-subagent.jsonl` | v2 | same as above | a `read` tool_use with `status:"error"`, plus a foreground `subagent` tool_use (child id at `part.state.metadata.metadata.sessionID`) |
| `v2-run-subagent-background.jsonl` | v2 | `run --standalone --format json --auto -m opencode/deepseek-v4.1-flash-free` | a `subagent` with `background:true`; `metadata.metadata.status:"running"`, plus the background output text |
| `v2-run-error-in-session.jsonl` | v2 | `run --standalone --format json -s ses_e825ffffffffUnknownSpike01 -m opencode/glm-5.3-flash-free` | `-s <unknown>` creates the session; the turn then fails with the in-session `error` `provider.free-limit` (HTTP 429). Exit 1. |
| `v2-run-error-pre-session.jsonl` | v2 | `run --standalone --format json -f /nonexistent-spike-file -m opencode/big-pickle` | pre-session `error` with `sessionID:""`. Exit 1. |
| `v2-run-error-insufficient-funds.jsonl` | v2 (2.1.3) | `run --standalone --format json -m opencode/deepseek-v4.1-flash` on an account with an empty Zen balance (2026-11-02; ids synthetic) | `provider.quota` HTTP 402 "Upstream request failed: Insufficient account funds"; the same model as `opencode-go/deepseek-v4.1-flash` answers on a Go subscription. Exit 1. |
| `v2-run-error-bad-model.jsonl` | v2 | `run --standalone --format json -m nope/nothing` | `provider.no-route` "Model unavailable", sessionID **set**. Exit 1. |
| `v2-run-error-unknown-variant.jsonl` | v2 | `run --standalone --format json -m 'opencode/deepseek-v4.1-flash-free#bogus'` | `provider.no-route` "Variant unavailable for …: bogus". Exit 1. |
| `v2-run-interrupted-shared.jsonl` | v2 | Shared mode (no `--standalone`) in detached tmux; `C-c` sent while `sleep 40` ran | only `step_start`; no `error` event; exit file `130` |
| `v2-run-unknown-flag.txt` | v2 | `run --standalone --variant high …` | help text plus `ERROR\n  Unrecognized flag: --variant in command opencode run`. Exit 1. |
| `v1-run-tools-todowrite.jsonl` | v1 | `run --format json --thinking --auto -m opencode/glm-5.3-flash-free` | `bash` ×2, `todowrite` (todos carry `priority`), final text, every step closed by `step_finish` (`tokens.total` present) |
| `v1-run-subagent.jsonl` | v1 | same | a `read` tool_use with `status:"error"` (string `state.error`, no `metadata`), plus a `task` tool_use (child id at `part.state.metadata.sessionId`) |
| `v1-run-error-bad-model.jsonl` | v1 | `run --format json -m nope/nothing` | v1 `error` shape `{name:"UnknownError", data:{message, ref}}`, sessionID set. Exit 1. |
| `v1-run-unknown-variant-accepted.jsonl` | v1 | `run --format json --variant bogus -m opencode/deepseek-v4.1-flash-free` | accepted silently, exit 0 (export shows `variant:"bogus"`) |
| `v1-run-error-pre-session.txt` | v1 | `run --format json -f /nonexistent-spike-file` | **not JSON**: stderr `\e[91m\e[1mError: \e[0mFile not found: …`. Exit 1. |
| `v1-resume-not-found.txt` | v1 | `run --format json -s ses_e825ffffffffUnknownSpike01 …` (stderr only; stdout was empty) | **not JSON**: `\e[91m\e[1mError: \e[0mSession not found`. Exit 1. |
| `v1-run-unknown-flag.txt` | v1 | `run --standalone --format json …` | yargs help for `opencode run`, **no** "Unknown argument" line. Exit 1. |
| `v2-session-list.json` | v2 | `session list --standalone --format json` | `[{id, title?, updated, created, projectId, directory}]`; `title` is **absent** when the session has none |
| `v2-session-list-table.txt` | v2 | `session list --standalone` | tab-separated `id\ttitle\tdate`; "Untitled session" when untitled |
| `v1-session-list.json` | v1 | `session list --format json` | `[{id, title, updated, created, projectId, directory}]` (auto-generated titles) |
| `v1-session-list-table.txt` | v1 | `session list` | table with a header row |
| `v2-session-export.json` | v2 | `session export --standalone ses_e8261398affehUf22D8iOXNtgS` (the parent of `v2-run-subagent.jsonl`) | `{info, messages}`; message types `user` / `assistant` / `idle`; `info.outcome:"succeeded"` |
| `v2-session-export-child.json` | v2 | `session export --standalone ses_e82612922ffe6VVY5SiPNRsanX` | child: `info.parentID`, `info.agent:"explore"`, `info.title` = the subagent description |
| `v2-session-export-bg-child-dead.json` | v2 | export of the background child in `v2-run-subagent-background.jsonl`, after the Standalone run exited | `info.outcome:null`, no `time.idle`, last assistant `finish:"error"`: the child died with the private server |
| `v1-session-export.json` | v1 | `export ses_e825ec104ffenteQsfLQHUAZwn` (stdout; stderr printed `Exporting session: <id>`) | `{info, messages:[{info, parts}]}`; parts have the same shape as run parts |
| `v1-session-export-child.json` | v1 | `export ses_e825eafb7ffeOjjZhBrQwKVqet` | child: `info.parentID`, `info.agent:"explore"`, title `… (@explore subagent)` |
| `v1-export-not-found.txt` | v1 | `export ses_doesnotexist000000000000` (2>&1) | `Exporting session: <id>` then `Error: Session not found: <id>`. Exit 1. |
| `v2-auth-list-empty.txt` / `.json` | v2 | `auth list --standalone` / `--format json` | `No authenticated integrations` / `[]` |
| `v2-auth-list-env.txt` / `.json` | v2 | same with `ANTHROPIC_API_KEY=dummy-not-a-key` | an env connection: `[{id,name,connections:[{type:"env",name}]}]` |
| `v1-auth-list-empty.txt` | v1 | `auth list` | clack box ending `0 credentials` (v1 has no `--format`) |
| `v1-auth-list-env.txt` | v1 | same with `ANTHROPIC_API_KEY=dummy-not-a-key` | adds an `Environment` box: `1 environment variable` |
| `v2-models.txt` | v2 | `models --standalone` | one `provider/model` per line (keyless: Zen free models only) |
| `v1-models.txt` | v1 | `models` | same format |
| `v1-models-verbose.txt` | v1 | `models --verbose`, first two models kept | `provider/model` line, then a pretty JSON block with `variants: {<id>: {...}}` |
| `v2-api-model-list.json` | v2 | `api --standalone model.list` | `{location, data:[{providerID, id, name, variants:[{id, settings}], …}]}` |
| `v2-api-model-default.json` | v2 | `api --standalone GET /api/model/default` | `{location, data:{providerID, id, …}}` (keyless default: `opencode/big-pickle`) |
| `v1-serve-config-providers.json` | v1 | `serve --port 0`, then `GET /config/providers`, trimmed to two models of the `opencode` provider | `{default:{<provider>:<model>}, providers:[{id, models:{<id>:{variants:{<v>:{…}}}}}]}` |
| `v2-api-session-busy.json` | v2 | `api GET /api/session/<id>` (Shared) while a turn ran, and after `C-c`; a `jq '.data'` projection of the two answers | `outcome:null` and no `time.idle` while busy; `outcome:"interrupted"` and `time.idle` after |

## Test doubles (code, not captured)

These three files are not recordings. They are the fake OpenCode 2.x server that the v2 server driver is tested against (`docs/plans/opencode-server-driver.md`, D13). Their event orders and error shapes follow the live OpenCode 2.1.3 transcripts of plan assumptions A1 to A5 (permission asks for read/edit/shell, empty form answers, a shared-service session resumed on another server, the `provider.quota` 402 failure, a background subagent waking its parent) and of the r2 and r3 spikes in `docs/plans/opencode-server-driver-spikes.md` (Reject semantics, the inbox after an interrupt, the children listing order); the few behaviours not seen live are marked "unverified" in the comments of `fake-serve.ts`.

| File | Line | Run as | Notes |
| --- | --- | --- | --- |
| `fake-serve.ts` | v2 | `bun fake-serve.ts --hostname 127.0.0.1 --port 0`, or `startFakeOpencodeServer(opts)` in-process | Basic auth `opencode:$OPENCODE_PASSWORD` (a random one is printed like the real `serve` when unset), `server listening on http://127.0.0.1:<port>` on stdout, the `/api/info`, `/api/event` and `/api/session…` routes the driver uses, sessions kept in memory. Scenarios are picked by a marker in the prompt text: `__agetor_fake_oc_steer__`, `_permission__`, `_question__`, `_subagent__`, `_wake__`, `_error__`, `_slow__`, `_stuck__` (the interrupt answers `{interrupted:true}` and nothing ends; only deleting the session or stopping the server does), `_bgslow__` (a background child and then the parent each run a shell until interrupted), `_todo__`, `_retry__`, `_files__`, `_tool__` (no marker: one `ACK: <prompt>` step). Env: `FAKE_OC_SPEED` (delay multiplier, default 1), `FAKE_OC_HEARTBEAT_MS` (default 15000), `FAKE_OC_STATE_FILE` (persist sessions across a restart), `FAKE_OC_QUOTA_MODELS` (default `opencode/deepseek-v4.1-flash`, fails with the 402), `FAKE_OC_VERSION`, `FAKE_OC_INTERRUPT_DELAY_MS` (the interrupt route waits this long before it acts and answers, default 0). Inbox: an item enqueued on an idle session starts an execution, unless its prompt said `resume: false`: then it only waits in the inbox, and a re-post of the same id (no `resume`) answers the same record and starts the execution that delivers it, once (r3 Q8); one still undelivered when an execution ends `interrupted` stays parked, with no event, until the next execution delivers it first; `GET …/inbox` lists the undelivered items, `DELETE …/inbox/{id}` cancels one (204 and one `session.inbox.cancelled`; 204 and no event for an unknown, delivered or already cancelled id; 400 for an id not starting `msg_`). Also `GET …/permission/{id}` (404 once settled; the 200 shape of a pending one is unverified), a Reject that declines only the same session's other requests, `/api/session/active` listing a session that waits on a permission or a question as `running` like a working one (r3 Q10 saw it for a permission; the question case is the fake's extension), and the children listing ordered by `time.updated` with a keyset cursor |
| `stub-opencode.sh` | v2 | `AGETOR_OPENCODE_BIN=<abs path>/stub-opencode.sh` | `--version` → `opencode v2.1.3`; `serve …` → `exec bun fake-serve.ts …` (set `FAKE_OC_BUN` when `bun` is not on PATH); `models` → two ids; `api --standalone model.list` → a two-model catalog; `auth list … --format json` → one credential; anything else exits 1 |
| `fake-serve.test.ts` | | `bun test src/bun/fixtures/opencode/fake-serve.test.ts` | compares the non-delta event-type sequence of the tool, steer, interrupt, subagent and 402 scenarios with the `v2-http-*` recordings, and of permission, question, wake with orderings copied from the T4 live runs (the allow-list of known-varying orderings is documented in the test); pins that a mid-stream message snapshot holds `text: ""` until `*.ended`; pins the r3 facts (the inbox after an interrupt and its DELETE, `resume: false` and the re-post that starts it, the active list while a card is pending, Reject across siblings, the children order and cursor); keeps two behaviours no spike observed, a DELETE of a queued prompt during an execution (never delivered) and `GET …/permission/{id}` answering a pending request with itself, in a separate "not verified live" block; pins the `stuck` marker and `FAKE_OC_INTERRUPT_DELAY_MS`, and that `stop()` resolves after a client aborted its event stream; also covers the stub script |

## v2 server-driver event fixtures (`v2-http-*`)

`GET /api/event` envelopes (`{type,data}`, one per line) and `GET /api/session/{id}/message` snapshots (one message per line) for the event mapper (`src/bun/opencode-events.ts`). Ids are synthetic (`ses_fixture…`). The four marked *live* are sanitized captures from the 2026-11-03 OpenCode 2.1.3 spikes; the rest are synthesized to the v2.1.3 event schema.

| File | Source | What it captures |
| --- | --- | --- |
| `v2-http-tool-turn.jsonl` | live (spike q3) | a two-step turn: `shell` tool call and success, `OK` text, `step.ended` with tokens, `usage.updated`, `execution.succeeded`, plus ignored `server.connected`, `inbox.*`, `shell.*` |
| `v2-http-messages-tool-turn.jsonl` | live | the message snapshot of the same turn (user, two assistant, idle), same ids |
| `v2-http-steer.jsonl` | live (spike q4) | two `inbox.enqueued` deliveries (a steer) in one execution; final text `DONE\n\nBANANA` |
| `v2-http-interrupt.jsonl` | live (spike q9) | an interrupted execution (`tool.failed` aborted, `step.failed` with tokens, `execution.interrupted` reason `user`), then a second execution that succeeds |
| `v2-http-subagent.jsonl` | live (spike q7) | parent and child sessions interleaved (`session.created{parentID}`, child tool and execution events) |
| `v2-http-todowrite.jsonl` | synthesized | reasoning, `todowrite` (with `priority` and `cancelled` items), final text |
| `v2-http-messages-todowrite.jsonl` | synthesized | the matching snapshot |
| `v2-http-quota-402.jsonl` | synthesized (shape confirmed live, A4) | `step.failed` then `execution.failed`, both `provider.quota` 402 |
| `v2-http-messages-quota-402.jsonl` | synthesized | the matching snapshot (assistant `error`, no content, idle `failed`) |
| `v2-http-retry.jsonl` | synthesized | two `retry.scheduled` (with `retryAfterMs`), then a successful step |

Every capture above the two code sections is a real recording; the `v2-http-*` files marked *synthesized* and the test doubles are the only non-recorded files here.
