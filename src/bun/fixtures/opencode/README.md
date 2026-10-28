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

No file here is synthetic.
