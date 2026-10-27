# Spikes — Add OpenCode harness (Wave 0, S0)

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Plan | `docs/plans/add-opencode-harness.md` (§3 decisions D-1…D-19, §4 Wave 0) |
| Binaries | **v2**: `brew install opencode` → 2.1.3 (`/opt/homebrew/bin/opencode`). **v1**: `npm i --prefix <scratch>/oc1 opencode-ai@1` → 1.19.4 |
| Isolation | Every probe ran with `HOME` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` under an empty scratch home (one per line), `OPENCODE_DISABLE_AUTOUPDATE=1`, and a `perl -e 'alarm N; exec @ARGV'` bound. tmux probes used the socket `-L oc-spike`. |
| Credentials | None. OpenCode Zen ships **keyless free models** (`opencode/*-free`, `opencode/big-pickle`), so **every turn below is a real live turn**, not source-only. |
| Fixtures | `src/bun/fixtures/opencode/` (all `captured`; index in its `README.md`) |
| Source used for "why" | `anomalyco/opencode` tag v2.1.4 (the step-1 copy) and `strings` of the 1.19.4 binary. Cited as `oc2:` and `oc1-bin:`. |

Commands below drop the isolation wrapper. `v2$` means `opencode` 2.1.3 and `v1$` means 1.19.4, both run in a scratch git repo.

## 1. Verdicts

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| Q1 | `--version` format | v2 prints **`opencode v2.1.3`**. v1 prints **`1.19.4`**. Both exit 0 in about 0.3 s. Parse with `/(\d+)\.(\d+)\.(\d+)/`; the leading `opencode v` on v2 means a bare `^\d` check fails. | `v2$ opencode --version`, `v1$ opencode --version`; `v2-version.txt`, `v1-version.txt` |
| Q2 | Stdin delivery in `sh -c` with no TTY, inside detached tmux | **Works on both, verbatim.** `tmux -L oc-spike new-session -d -x 200 -y 50 -c <cwd> -- sh -c '"$@" < '<p>' > '<log>' 2>&1; echo $? > '<exit>'' sh opencode run --format json --thinking [--standalone] -m <id>` gave exit 0. The prompt `…: fix the "bug" now` reached the model unchanged (`session export` user text matches the file byte for byte). The same text passed as **one positional argv element** arrived as `"Reply with exactly: fix the \"bug\" now"`, with literal quotes and escapes (v2). | tmux sessions `q2v2`/`q2v1`; exports compared |
| Q3 | NDJSON shapes | Captured on both lines (see §2 for field paths): `step_start`, `reasoning` (needs `--thinking`), `text`, `tool_use` completed/error (`read`, `shell`/`bash`, `todowrite`, `subagent`/`task`), `step_finish` (tokens + cost), and `error` (pre-session and in-session). **Three differences matter:** (a) in a v2 tool part, `part.id` is the provider call id and `part.partID` is the `prt_…` id; v1 is the reverse (`id` = `prt_…`, `callID` = call id). (b) **v2 often drops the turn's final `step_finish`**: 7 of 10 v2 runs ended without it, 0 of 6 v1 runs did. (c) v1's pre-session errors are **not JSON** (see Q16). | `v2-run-*.jsonl`, `v1-run-*.jsonl` |
| Q4 | `-s <unknown id>` | **v1**: nothing on stdout. stderr gets `\e[91m\e[1mError: \e[0mSession not found` (no id in the text). Exit 1. A malformed id gives the same result. **v2: creates the session.** `ses_e825ffffffffUnknownSpike01` showed up in `session list` afterwards and the turn ran (here it then hit the free-limit error). | `v1$ opencode run --format json -s ses_e825ffffffffUnknownSpike01 -m … < p`; `v1-resume-not-found.txt`; `v2-run-error-in-session.jsonl` |
| Q5 | Cross-line flags | **v1 rejects `--standalone`.** It prints `opencode run`'s yargs help on stderr, exit 1, with **no** "Unknown argument" line. **v2 rejects `--variant`**: help, then `ERROR\n  Unrecognized flag: --variant in command opencode run`, exit 1. Version-gated argv (G1) is required. | `v1-run-unknown-flag.txt`, `v2-run-unknown-flag.txt` |
| Q6 | Unknown variant | **v2 fails the turn.** It emits `{"type":"error","sessionID":"ses_…","error":{"type":"provider.no-route","message":"Variant unavailable for opencode/deepseek-v4.1-flash-free: bogus"}}` and exits 1 (the session has already been created). **v1 accepts it silently.** It exits 0, and the export stores `model.variant:"bogus"` (so the run had no reasoning effort). A valid variant is recorded the same way on both (`info.model.variant:"high"`). | `-m 'opencode/deepseek-v4.1-flash-free#bogus'` / `--variant bogus`; `v2-run-error-unknown-variant.jsonl`, `v1-run-unknown-variant-accepted.jsonl` |
| Q7 | `models` | Both print one `provider/model` per line, sorted, exit 0 (v2 ~1.2 s, v1 ~2 s). **v2 accepts `--standalone`.** It lists **only credentialed providers plus keyless Zen**: with no creds it lists 9 v2 / 10 v1 `opencode/…` ids; with `ANTHROPIC_API_KEY=<dummy>` it lists 29, 20 of them `anthropic/…`. **In v2 Shared mode, `models` shows the background service's providers, not the caller's env**: the same dummy key gave 9 lines without `--standalone`. v1 `models --verbose` adds a pretty JSON block **with `variants`** after each id. | `v2-models.txt`, `v1-models.txt`, `v1-models-verbose.txt` |
| Q8 | `serve` and the variants endpoint | **v2**: `opencode serve --port <n>`; `0` means a random port. Ready line on stdout: **`Server listening on http://127.0.0.1:<port>`**, followed by `server password <pw>` unless `OPENCODE_PASSWORD` is set. Then **every `/api/*` route needs Basic auth `opencode:<pw>`** (401 `{"_tag":"UnauthorizedError"}` otherwise; non-`/api` paths serve the web app's HTML). Variants: **`GET /api/model` → `.data[]` → `{providerID, id, variants:[{id, settings}]}`**. The default model is `GET /api/model/default` → `.data`. **`opencode api --standalone model.list` returns the same JSON in one process (~1.1 s, exit 0), with no port or password to handle.** **v1**: `opencode serve --port <n>` (`--port 0` bound **4096**, the default). Ready line: `opencode server listening on http://127.0.0.1:<port>`, preceded by `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` No auth unless that env var is set. Variants: **`GET /config/providers` → `.providers[].models.<modelId>.variants` (object; keys in order)**, default `.default.<provider>`. v1 has no `api` subcommand, but **`opencode models --verbose` already carries `variants`**, so neither line needs `serve`. | `v2-api-model-list.json`, `v2-api-model-default.json`, `v1-serve-config-providers.json`, `v1-models-verbose.txt` |
| Q9 | `auth list` when empty | **v2** `auth list --standalone` → `No authenticated integrations`; `--format json` → `[]`. An env credential gives `[{"id":"anthropic","name":"Anthropic","connections":[{"type":"env","name":"ANTHROPIC_API_KEY"}]}]`. Without `--standalone` it reports the **service's** env (`[]` despite the dummy key). **v1** `auth list` → a clack box (ANSI) ending `└  0 credentials`. An env key adds a second box `●  Anthropic ANTHROPIC_API_KEY … └  1 environment variable`. **v1 rejects `--format`** (help, exit 1). | `v2-auth-list-*.{txt,json}`, `v1-auth-list-*.txt` |
| Q10 | `session list --format json` | **v2**: `[{id, title?, updated, created, projectId, directory}]`, newest first, top-level sessions of the cwd's project. **`title` is absent** when the session has none (the table prints "Untitled session"). **v1**: `opencode session list --format json` exists (`-n/--max-count`, `--format table\|json`) with the same keys and `title` always present (v1 auto-generates titles). **Neither list has a busy/status field.** Busy signal on v2: `opencode api GET /api/session/<id>` (or the export's `info`) has `outcome:null` and no `time.idle` while a turn runs, then `outcome:"succeeded"\|"interrupted"` plus `time.idle`. v1 has no outcome field. Busy there means the last message is an assistant without `time.completed`. | `v2-session-list.json`, `v1-session-list.json`, `v2-api-session-busy.json` |
| Q11 | `session export` | **v2** `opencode session export [--standalone] <id>` → `{info, messages}` with message `type` `user\|assistant\|idle` (§2c). Completion marker: `info.outcome` non-null plus a final `{type:"idle", outcome}` message. Model/agent: `info.model {id, providerID, variant}`; `info.agent` only on child sessions; per-message `agent`/`model` on assistant messages. Works with **or** without `--standalone`; without it, the call starts the background service. **v1** has **no `session export`**. The command is top-level **`opencode export <id>`** → `{info, messages:[{info, parts}]}` (§2d), and it prints `Exporting session: <id>` on **stderr**. No idle marker: done = the last assistant `info.time.completed` set and `info.finish !== "tool-calls"`. Not found: `Error: Session not found: <id>` on stderr, exit 1. | `v2-session-export*.json`, `v1-session-export*.json`, `v1-export-not-found.txt` |
| Q12 | Subagent tool result | **v2** tool `subagent`, input `{agent, description, prompt, background?, sessionID?, model?}`. Child id at **`part.state.metadata.metadata.sessionID`**, status at `…metadata.metadata.status` (`completed\|running`). Foreground output `<subagent sessionID="ses_…" state="completed">\n…\n</subagent>`. Background output `The subagent is working in the background (sessionID: ses_…). You will be notified automatically when it finishes.\n…`. Failures are `state.status:"error"` with `Subagent failed (sessionID: ses_…): …` / `Subagent cancelled (sessionID: ses_…)` (oc2 `tool/plugin/subagent.ts:19–27,245–251`). **v1** tool `task`, input `{subagent_type, description, prompt, background?}`. Child id at **`part.state.metadata.sessionId`** (lower-case `d`), plus `parentSessionId` and `model`. Output `<task id="ses_…" state="completed">\n<task_result>…</task_result>\n</task>`. Background needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (otherwise the tool errors) and then reports `state="running"` with `metadata.background:true, jobId` (oc1-bin). **A v2 Standalone background child dies when the client exits**: its export keeps `outcome:null` and its last assistant has `finish:"error"`, permanently. | `v2-run-subagent*.jsonl`, `v1-run-subagent.jsonl`, `v2-session-export-bg-child-dead.json` |
| Q13 | Standalone ↔ Shared resume | **Yes, both directions** (same `opencode.db`). A session created with `--standalone` was resumed in Shared with `-s` and recalled its last reply. A Shared-created session was resumed with `--standalone` and recalled a code word. | runs `r2d`, `r2e`→`r2f` |
| Q14 | Kill behavior | **Standalone + `tmux kill-session` mid-turn** (a `sleep 40` tool running): 3 s later no `opencode run`, no `opencode serve --stdio --port 0` and no `sleep` remained. No exit file (the shell was killed). The session stays `outcome:null`, last assistant `finish:"error"`, and **resumes fine** with `-s` afterwards. **Shared + `C-c`**: the client exited **130 within ~0.01 s**; the daemon recorded `outcome:"interrupted"`, and the `sleep` tool child was gone. **v2 Standalone + `C-c`**: exit 130 within 0.12 s, the tool child and stdio server gone. **v1 + `C-c`**: see Q16; v1 **leaves the bash tool's child process running**, reparented to PID 1. | tmux `q14stand`, `q14shared`, `q16v2s`, `q16v1`, `q16v1b` |
| Q15 | `--title` | Accepted on both. On v2, `--title "Spike title one"` named a new session (`session list` shows it). On a later turn, `-s <that id> --title "Ignored title two"` **kept the old title**, so `--title` is ignored when resuming. v1 auto-titles a session whenever `--title` is absent. | `v2-session-list-table.txt` |
| Q16 | Exit codes | `0` = success. `1` = any `error` event, unknown flag, v1 resume-not-found, v1 pre-session error, v2 unknown variant/model. `130` = SIGINT: v2 always exits 130 itself. **v1 dies from the signal**, so `sh` (macOS `/bin/sh` = bash) dies with it and **never writes the exit file**. With `trap 'true' INT;` at the start of the inner script, `sh` survives and records `130` (0.02 s). An interrupted v2 run emits **no** `error` event. | tmux runs above |
| Q17 | `OPENCODE_DISABLE_AUTOUPDATE` | **The name is right on both lines**, and both honor it in source. v2: `services/updater.ts:534`, `"1"`/`"true"` (case-insensitive). v1: `mc("OPENCODE_DISABLE_AUTOUPDATE")` truthy plus a config `autoupdate:false` (oc1-bin). There is no live signal to observe, because the update check runs only in the interactive TUI (`oc2: commands/handlers/default.ts:62`) and never in `run`. Keeping `??= "1"` is harmless. | source |
| — | Copilot kind id | **`copilot`** (`feature/add-github-copilot-harness` @ `82d670c`, `docs/plans/github-copilot-harness.md` + investigation:331). Migration `075_copilot_harness.sql` (provisional), CHECK `('claude-code','codex','cursor','grok','gemini','kimi','fx','antigravity','opencode','copilot')`. That plan also adds a `MODEL_DEFAULT_EFFORT_KINDS` set so `supportedEfforts` keeps `auto` for copilot. That edits the same function as D-6, so expect a merge conflict there. | `git show feature/add-github-copilot-harness:…` |

## 2. Field paths the code must read

### 2a. `opencode run --format json` lines (both lines)

Envelope: `{type, timestamp, sessionID, part? , error?}`. `sessionID` is `""` only on a v2 pre-session error.

| Event | v2 2.1.3 | v1 1.19.4 |
| --- | --- | --- |
| `step_start` | `part {id:"prt_…", messageID, type:"step-start", snapshot}` | same |
| `text` | `part {id:"prt_…", messageID, type:"text", text, time{start,end}}` (whole block) | same |
| `reasoning` | `part {id, type:"reasoning", text}` (only with `--thinking`) | same |
| `tool_use` | `part {partID:"prt_…", id:<call id>, type:"tool", tool, state:{status, input, output?, error?:string, title, metadata:{metadata:{…tool metadata}, content:[{type:"text",text}], providerCall, providerResult, rawInput}, time}}` | `part {id:"prt_…", callID:<call id>, type:"tool", tool, state:{status, input, output?, error?:string, title, metadata?:{…tool metadata}, time}}` |
| tool names seen | `read`, `shell`, `todowrite`, `subagent`, `execute` | `read`, `bash`, `todowrite`, `task` |
| `todowrite` input | `{todos:[{content, status}]}`, status ∈ `pending\|in_progress\|completed\|cancelled` | `{todos:[{content, status, priority}]}` |
| `step_finish` | `part {id:"prt_…", type:"step-finish", reason:"tool-calls"\|"stop", cost:<number USD>, tokens:{input, output, reasoning, cache:{read, write}}}`. **Often missing for the last step.** | same, plus `tokens.total` |
| `error` | `error {type, message, status?, response?, retryAfterMs?}` (seen: `provider.free-limit`, `provider.no-route`, `unknown`) | `error {name, data:{message, ref?}}` (seen: `UnknownError`) |

- **Line uuids:** tool `opencode:tool:<part.partID ?? part.id>:use|result` (the `prt_…` id on both); other parts `opencode:<type>:<part.id>`. **toolUseId:** `part.callID ?? part.id`.
- A shell command that exits non-zero is still `status:"completed"`. Only a tool failure (e.g. `read` on a missing file → `File not found: …`) is `status:"error"`.

### 2b. Non-JSON lines in the log (v1, stderr merged by `2>&1`)

- ANSI strip: `/\x1b\[[0-9;]*m/g`.
- After stripping, a line matching **`/^Error:\s*(.+)$/`** is OpenCode's failure message. Seen on v1: `Error: Session not found` (resume of an unknown id), `Error: File not found: <path>`, `Error: Session not found: <id>` (export).
- **Resume-not-found (D-9):** `/^Error:\s*Session not found\s*$/` on a stripped line, with no `sessionID` seen and exit 1. It is v1-only, because v2 creates the session.

### 2c. v2 `session export` shape

```
{ info: { id, parentID?, projectID, agent? /*child only*/, title?, model:{id, providerID, variant},
          cost, tokens:{input,output,reasoning,cache:{read,write}},
          outcome: null | "succeeded" | "interrupted" | …, time:{created, updated, idle?}, location:{directory} },
  messages: [
    { id, type:"user", text, files:[], time:{created} },
    { id, type:"assistant", agent, model:{id,providerID,variant}, finish:"tool-calls"|"stop"|"error", rawFinish,
      cost, tokens, snapshot, time:{created, streamed?, completed?},
      content: [ {type:"reasoning", text, native?, time},
                 {type:"text", text},
                 {type:"tool", id:<call id>, name, executed, time,
                  state:{status, input, content?:[{type:"text",text}], metadata?:{…}, error?:{type,message}}} ] },
    { id, type:"idle", outcome, time:{created} } ] }
```

- Content items have **no part id**. Line uuid: `opencode:<message.id>:<contentIndex>` (a tool pair: `…:<i>:use|result`).
- Tool name is `name` (not `tool`). Output is `state.content[].text` (not `state.output`). Error is an **object**.
- Subagent child id here is `state.metadata.sessionID` (one level, not the NDJSON's `metadata.metadata`).
- **Complete:** `info.outcome !== null` and the last message is `type:"idle"`.
- **Running:** `info.outcome === null` and no `info.time.idle`.
- **Dead** (killed Standalone, or a Standalone background child): `outcome === null` permanently, last assistant `finish:"error"`.

### 2d. v1 `opencode export <id>` shape

```
{ info: { id, slug, parentID?, projectID, directory, title, agent, model:{id,providerID,variant}, version,
          summary, cost, tokens, permission:[…], time:{created, updated} },
  messages: [ { info:{ id, sessionID, role:"user"|"assistant", agent, mode?, parentID?, modelID?, providerID?,
                       finish?, cost?, tokens?, time:{created, completed?} },
                parts:[ /* same shapes as 2a parts, each with id "prt_…" */ ] } ] }
```

- Line uuid `opencode:<part.id>` works as planned.
- **Complete:** the last message is `role:"assistant"` with `time.completed` set and `finish !== "tool-calls"` (seen `"stop"`).
- The child has `info.parentID` and title `<description> (@<agent> subagent)`.

### 2e. Variant discovery

- **v2:** run `opencode api --standalone model.list` with `harnessEnv`. Then `JSON.parse(stdout).data[]`: id = `${providerID}/${id}`, variants = `variants.map(v => v.id)` (order kept; values seen `none, minimal, low, medium, high, xhigh, max`).
- **v1:** run `opencode models --verbose`. Repeat: a line matching `^[^\s{][^\s]*/\S+$` is the id, followed by a JSON object running from a line `{` to the next line `}` at column 0. Variants = `Object.keys(obj.variants)`; `{}` means none.
- No `serve`, no port, no password on either line. `models --verbose` also replaces the plain `models` call on v1, so one call covers both.

## 3. Amendments to §3

| # | Decision | Change |
| --- | --- | --- |
| A1 | **D-1, D-10** (wrapper / Stop) | The inner script must start with a SIGINT trap: `trap 'true' INT; "$@" < '<prompt>' > '<log>' 2>&1; echo $? > '<exit>'`. Without it, a v1 `C-c` kills `sh` along with OpenCode and no exit file is written (Q16). With it, both lines write `130`. A test should pin the trap prefix. Settle on a dead pane with no exit file (the death watch) must still read `cancelled` when the handle's `cancelled` flag is set. **Known v1 gap to document:** v1 does not kill the bash tool's child on SIGINT, so a long `sleep`/build keeps running after Stop (Q14). v2 does kill it. |
| A2 | **D-2** (`opencodeMajor`) | Match `/(\d+)\.(\d+)\.(\d+)/` anywhere in the output (v2 prints `opencode v2.1.3`, v1 prints `1.19.4`). Unparseable → 2, as planned. |
| A3 | **D-7** (variant discovery) | Replace step (3) "start a short-lived `opencode serve` on an ephemeral port" with **v2 `opencode api --standalone model.list`** and **v1 `opencode models --verbose`** (§2e). Both are one-shot, need no auth or port, and finish in under 2.5 s. Step (2)'s plain `models` call is no longer needed on either line, since the same output gives the ids. Keep the "any failure → ids without efforts" fallback. For reference, if `serve` is ever needed: §1 Q8 (v2 Basic `opencode:<pw>` / `GET /api/model`; v1 `GET /config/providers`). *G5 says "through OpenCode's local server API"; `opencode api --standalone` is that API (`client.model.list`) on a private server, so the outcome is unchanged. This is a change of mechanism, not a G contradiction.* |
| A4 | **D-8 / W1-C mapper table** | (a) **Tool line uuid** is `opencode:tool:<part.partID ?? part.id>:use\|:result`. On v2, `part.id` is the provider call id (`chatcmpl-tool-…` or a uuid), not the part id. `toolUseId = part.callID ?? part.id` stays. (b) `step_finish.cost` is a **number** (USD). Map it to `cost:{amount: cost, currency:"USD"}`, and treat `tokens.total` (v1) as ignorable. (c) **v2 often omits the final `step_finish`** (7/10 runs). When a v2 turn exits 0 with fewer `step_finish` than `step_start` lines, the driver should, before settle, reconcile usage from `session export` by summing `tokens`/`cost` over the assistant messages after the last `user` message, and emit the usage sentinel from that. Otherwise the chip under-counts the last step. (d) Subagent detection: v2 `tool === "subagent"`, child `state.metadata.metadata.sessionID`; v1 `tool === "task"`, child `state.metadata.sessionId`. Text fallback on output/error: `/sessionID[=:]\s*"?(ses_[A-Za-z0-9]+)/` (v2) and `/<task id="(ses_[A-Za-z0-9]+)"/` (v1). `agentType = input.agent ?? input.subagent_type ?? null`. `background = input.background === true` (v2 `metadata.metadata.status === "running"`, v1 `metadata.background === true`). (e) `todowrite`: drop v1's `priority`; `cancelled → completed` as planned. (f) The `error` row: v2 `error.message`, v1 `error.data.message`; v2 may add `retryAfterMs`, worth showing for `provider.free-limit`. (g) Non-JSON lines are **not** purely skipped. After an ANSI strip, an `^Error:\s*(.+)$` line becomes the turn's last error (`status` `opencode: <msg>`, `failed`). That is how v1 pre-session errors and v1 resume-not-found surface (§2b). |
| A5 | **D-9** (failed resume) | `resumeNotFound` fires on a **non-JSON** v1 log line matching `/^Error:\s*Session not found\s*$/` (after the ANSI strip), with no `sessionID` seen and exit 1. v2 never needs it (Q4: `-s` creates). |
| A6 | **D-11** (subagent tabs) | (a) **Standalone background children die with the client** (Q12). At settle, for a task whose turn ran Standalone (or on v1), a child export with `info.outcome === null` (v2), or a last message without `time.completed` (v1), means the child is gone. Set the row **`failed`** (status line `OpenCode subagent "<desc>" stopped when the turn ended`), not `orphaned`. Keep `orphaned` + re-check only for Shared-mode turns, where the daemon keeps the child running. The driver knows the mode of the turn it launched. A reattached turn without that record should use `orphaned`. (b) v1 background subagents need `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, which agetor does not set, so v1 children are always foreground and complete. (c) The export command differs: v2 `opencode session export --standalone <id>`, v1 **`opencode export <id>`**. |
| A7 | **D-12** (`opencode-export.ts`) | Two shapes, not one (§2c/§2d). v2 content items have **no part id**, so their line uuid is `opencode:<messageId>:<index>` (not `opencode:<partId>`). The v2 tool fields are `name`, `state.content[].text`, `state.error.message`; v1 parts are run-shaped. `exportIsComplete`: v2 = `info.outcome !== null && last.type === "idle"`; v1 = last assistant `time.completed && finish !== "tool-calls"`. Mark the "one shared part→chunk function" as true for v1 only; v2 export needs its own content→chunk adapter. |
| A8 | **D-13** (import) | (a) v1 **does** have `session list --format json` and `export`, so import works on **both lines**; no v2-only gate. (b) v2's list JSON lacks `title` when untitled: read `title ?? null`. (c) The **busy check is not in `session list`**. Use the export's `info.outcome === null` (v2) / last message without `time.completed` (v1). A hard-killed session stays "busy" forever (Q14), so a strict refusal would block it permanently. Recommend: refuse only when that condition holds **and** `info.time.updated` is within the last 10 minutes; otherwise import with a status line `OpenCode reported this session unfinished`. *This refines G14a ("a session OpenCode reports busy is refused") and goes back to the owner for confirmation.* (d) Scan with `--standalone` on v2 (Shared starts the service). (e) Map the imported model from `info.model` (`providerID/id`, `variant` → effort unless `"default"`). Map mode from the last assistant `agent` (`build` → auto, `plan` → plan). |
| A9 | **D-16** (login hint) | v2 must run **`auth list --standalone --format json`**. Without `--standalone` it reports the background service's env and starts it. Empty = `[]`. v1 has **no `--format`** (exit 1). Parse the text instead: empty iff it contains `0 credentials` and no `environment variable` line (`/(\d+) credentials?/`, `/(\d+) environment variables?/`). |
| A10 | **D-3** (argv) | All spellings confirmed. `--title` is ignored when `-s` resumes an existing session, so passing it only on fresh sessions is right. `--agent plan` works on v2 (export `agent:"plan"`). **A stale effort fails a v2 turn** (`provider.no-route`, "Variant unavailable …", exit 1) and is silently ignored on v1. No argv change; the error must reach the user (A4f). |
| A11 | **D-19** (breadcrumb) | No change. If the label for the sentinel should name the real model: v2 `opencode api --standalone GET /api/model/default` → `.data.providerID + "/" + .data.id`; v1 `/config/providers .default`. Keyless default is `opencode/big-pickle`. Optional. |
| A12 | **D-14 / W1-E** (status probes) | Any OpenCode invocation, even `--version`, creates `$XDG_DATA_HOME/opencode/{log,repos}`, `$XDG_CONFIG_HOME/opencode`, `$XDG_STATE_HOME/opencode`, `$XDG_CACHE_HOME/opencode/bin` and appends to `log/opencode.log`. So does `brew install opencode`. This is harmless, but `checkHarness`/`cachedCliVersion` write into the harness home on every probe, which is one more reason to keep D-2's 60 s cache. |
| A13 | **D-6 / GD (live smoke W4)** | The Zen free quota is **per model**. `opencode/glm-5.3-flash-free` hit `provider.free-limit` (429, `retryAfterMs` ≈ 10 h) after ~9 turns on v2; other free ids kept working. The W4 smoke should use `opencode/deepseek-v4.1-flash-free` (variants `low,high,max`), `opencode/big-pickle` or `opencode/mimo-v2.6-flash-free`, and pace turns. |
| A14 | **D-4 / G3a** (Shared port) | Confirmed: the service binds the fixed `http://127.0.0.1:49374` and records `{url, pid, password}` in `$XDG_STATE_HOME/opencode/service.json`. `HOME`/`XDG` isolation does **not** isolate the port, so a second account's Shared turn could reach the first account's daemon. G3a (always Standalone with a home) stands. |
| A15 | Coordination (§2c) | The Copilot kind id is **`copilot`**, migration `075_copilot_harness.sql` (provisional). Its plan touches `supportedEfforts` too (`MODEL_DEFAULT_EFFORT_KINDS`). W1-A should express opencode's `auto` handling in a form that merges with that set (or adopt it). |

### Contradictions of grill decisions (owner)

- **G10 (TODO tracker from `todowrite`): partly false on v2.**
  - v2's `todowrite` tool exists only when the config has `experimental: { todo: true }`; the default is false (`oc2: schema/src/config/experimental.ts`, `core/src/tool/plugin/todo.ts`).
  - **Standalone:** with the flag on, the tool works (fixture `v2-run-tools-todowrite.jsonl` used `OPENCODE_CONFIG_CONTENT='{"experimental":{"todo":true}}'`).
  - **Shared mode:** the daemon ignores the client's `OPENCODE_CONFIG_CONTENT`. A Shared run with it set got "there's no `todowrite` tool available".
  - **What it means:** on v2 the tracker lights up only for users who enabled `experimental.todo` themselves. v1 always has the tool.
  - **Owner options:**
    - (a) Accept this and document it. (Recommended: no config injection.)
    - (b) Additionally inject `OPENCODE_CONFIG_CONTENT ??= '{"experimental":{"todo":true}}'` on Standalone turns only. Mapper and tracker work is unchanged either way.
- **G14a (refuse busy sessions): needs a refinement**, see A8(c). A killed session never stops reading as busy.
- **G5 (variants through `opencode serve`)**: the mechanism changes (A3), the outcome does not. Listed for visibility, not as a contradiction.
- Everything else in the grill holds:
  - G1: version-gated argv (Q5).
  - G2/GD3: stdin (Q2).
  - G3b: `C-c` stops a Shared turn within 0.01 s (Q14).
  - G4: sentinel / no `-m` (keyless default `big-pickle`).
  - G6: `--agent plan`.
  - G12: child ids are discoverable and exports exist on both lines.
  - G13: `--title` (Q15).
  - G14: `session list` exists on both lines.
  - GD4: discovered `ses_…` ids.
  - GD9: `--standalone` discovery (Q7 shows it is required).
  - GD13: error shapes, plus A4(g).
  - Grill open assumptions resolved: Standalone↔Shared resume (Q13); a v2 background child dies with Standalone (Q12); `step_finish.tokens` has v1's shape on v2 (Q3); `run` exits once the session goes idle after `--auto` approvals (every `--auto` run exited 0).

## 4. Housekeeping

- The two installs and my first un-wrapped `--version` calls created empty `~/.config/opencode`, `~/.local/share/opencode/{log,repos}` (plus one 155-byte `opencode.log` from the `--version` call), `~/.local/state/opencode` and `~/.cache/opencode/bin` in the real home. None of these existed before (investigation I§1d). All were removed again. No OpenCode credentials, sessions or config were ever written there.
- The isolated v2 background service (`opencode serve --service`, port 49374) was stopped with `opencode service stop`. Every `opencode serve` started for Q8 was killed, and the `oc-spike` tmux server was killed. Orphaned `sleep 40`/`sleep 20` tool children from the v1 `C-c` test were killed.
- Homebrew `opencode` 2.1.3 (and its `ripgrep` dependency, plus a `pcre2` 10.47→10.49 upgrade) stays installed for the W4 smoke. The v1 npm install lives only in the session scratchpad.

## Owner decisions on the grill contradictions (2026-10-27, during Implementing)

- **G10 / v2 `todowrite`:** accept and document. Map `todowrite` whenever it appears; on v2 the tracker needs `experimental.todo: true` in the user's own OpenCode config. Agetor injects no `OPENCODE_CONFIG_CONTENT`.
- **G14a / busy sessions:** refined per A8(c). Refuse an unfinished session only when it was also updated within the last 10 minutes; otherwise import it and post the status line `OpenCode reported this session unfinished`.
