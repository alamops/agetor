# Investigation — fx 0.0.15 upgrade, and the Full access shell failures

| Field | Value |
| --- | --- |
| Date | 2026-10-28 |
| Change | Move agetor's fx harness from fx 0.0.14 (last verified 2026-10-22) to fx 0.0.15 (released 2026-10-27), and explain the `invalid_shell_request` errors seen on a Full access fx task. |
| Sources | <https://github.com/vercel-labs/fx/releases/tag/v0.0.15>, source tarballs `vercel-labs/fx` v0.0.14 (`1a070af3`) and v0.0.15 (`7f2383af`), the v0.0.15 release binary `fx-macos-aarch64.tar.gz` (sha256 `9f7dcae1…a349b`, matches the published `.sha256`), <https://fx.sh/docs/configure-fx/custom-model-connections>, the prod DB (read-only) |
| Branch | `fix/upgrade-fx-and-check-full-access` (clean, at `497f6d43`) |

Machine state: fx `0.0.14` (`1a070af32cdf`) installed at `~/.local/bin/fx`, signed in (`auth: "fx login"`). macOS 26.6.2 (Darwin 25.6), arm64. `releases.fx.sh/latest.txt` reads `v0.0.15`. Nothing in this investigation ran fx 0.0.15 against the real `~/.fx`; every 0.0.15 run used an isolated HOME (see §2).

---

## 1. What we know

### 1a. The reported failure is a model/schema problem, not a Full access problem

The failing run is in the prod DB: task "Test FX" (`4eb18f30…`), harness `fx`, model **`zai/glm-5v-turbo`**, mode `yolo` (Full access), run `a02d7082…`, 2026-10-28 16:31. The model called `shell` twice with

```json
{"request": "{\"action\": \"run\", \"command\": \"git log --oneline -10 …\"}"}
```

`request` is a JSON **string** containing an object. fx 0.0.14 rejected both calls with `invalid_shell_request` / "request must be an object, not a JSON string." and then ended the turn with "Repeated shell validation failures stopped the tool loop." (`src/core/agent/runtime/orchestrator.zig:93`). The other tools in that run (`glob_files`, `read_file`) worked, because their arguments are flat.

- **Why only shell:** fx 0.0.14 advertises `shell`, `subagent` and `read_tool_result` with a single required top-level property, `request`, holding the real arguments (`v0.0.14 src/builtins/tools.zig`, `shell_request_properties`, `.required = &.{"request"}`). Some models serialize a nested object argument as a string. fx validates strictly and does not coerce it (`v0.0.14 src/tools/shell/shell.zig:207-215`, `request_correction`).
- **Why it is not about the mode:** argument validation runs before admission and permission review, so the same call fails in Auto, Ask and Full access. The prod run happened to be in Full access.
- **Why the retry didn't help:** fx tells the model "Call shell once using retry_with exactly" and includes a corrected call. The model sees the full error (279 chars, with `retry_with`). `glm-5v-turbo` resent the same stringified call instead.
- **Why agetor shows the error cut off:** fx sends an ACP client only a ~200-char preview of each tool result. The cut at `"retry_with":{"request"` is fx's, not agetor's (§2, S2).

**fx 0.0.15 fixes this.** "shell, subagent, and read_tool_result are advertised with top-level arguments" (`v0.0.15 src/core/agent/runtime/orchestrator.zig:303-309`). The shell schema now lists `action` (required), `command`, `cwd`, `session_id`, `chars`, `tty`, `yield_time_ms`, `timeout_ms`, `force`, `profile`, `shell` and `reload` at the top level (§2, S2). There is no nested object left for a model to stringify. fx 0.0.15 also:

- unwraps an exact `{"request":{…}}` object a model sends out of habit, on every step except a required vision call (`orchestrator.zig:307`, `request_unwrap_eligible`);
- infers a missing `action` when the other fields fit exactly one action (`v0.0.15 src/tools/shell/shell.zig:94-109`, `inferAction`);
- still rejects a *stringified* `request`, now with "Put the action fields at the top level; shell takes no request wrapper." and a flat `retry_with` (`shell.zig:283-290`).

So 0.0.15 removes the trigger rather than tolerating it. A model that still sends `{"request": "<json>"}` against the flat schema would still fail. That is unlikely, because the schema no longer has a `request` property to fill.

No agetor code change is needed for this fix. The user-visible fix is upgrading fx. The model in question is a vision model (`glm-5v-turbo`). Whether other weak models in agetor's fx list stringify too was not measured.

### 1b. What else 0.0.15 changes for an ACP host

Read from the source diff of `src/acp/*` (10 files, +1915/−1830) and the CLI output writers, then checked against the binary where marked. Paths are in `scratchpad/fxsrc/v0.0.15/`.

**Affects agetor (needs a decision or a fix):**

1. **A new session is not saved until its first turn starts** (`src/acp/sessions.zig:474`, "The session stays in memory until its first prompt"; `prompt.zig:1064` `v2.beginTurn()`). All sessions now use the v2 store, where 0.0.14 used v1 unless `FX_SESSIONS_V2` was set. If the first `session/prompt` ends before the turn begins, nothing is saved: the credential gate (`prompt.zig:867`, -32600), a Stop during the handshake, or a crash before the prompt. A later `session/resume` or `session/load` with that id then answers -32602 "Session not found". **Proved on the binary (S8).** agetor stores the fx session id as soon as `session/new` answers (`src/bun/fx-acp.ts:3079` `onSessionId`), and every follow-up resumes the newest stored id. After resume and load both fail, `runFxTurn` fails the turn (`fx-acp.ts:3045-3058`, "fx acp: failed to resume session … Session not found"). The next follow-up resumes the same dead id again, so the task stays broken until its harness changes. On 0.0.14 the same sequence resumed fine.
2. **`continueRecovery` no longer works on ordinary ACP sessions** (`prompt.zig:1023-1029`; S6). Only a libfx host that opens a journal can continue a paused turn; upstream design note D54/D80 (`tests/tla/session_manager/system-design.md`) replaces it with "send a new prompt after reopening". agetor's Resume button, `agetor resume`, the TUI `r` key and the auto-resume engine all send `continueRecovery`. On 0.0.15 they would fail with fx's text ("This session does not support durable recovery"), which `resumeFxRecovery` already surfaces verbatim, and auto-resume records `autoResumeStopped: "failed"`. In practice this is dead code already. fx's recovery policy has not produced a resumable pause on ACP since 0.0.11: `decide()` never returns `.pause` (`core/agent/runtime/model_response_recovery.zig`, unchanged from 0.0.14). The only `continue_later` pause comes from the TUI's pause flag (`core/app/app_agent_runtime.zig:1214`), and the one remaining ACP pause is `inspect_uncertain_tool` (`orchestrator.zig:7858-7862`), which `isFxRecoveryResumable` already rejects. The prod DB has no fx task with a stored pause.
3. **Resume no longer replays anything before its response.** 0.0.14 replayed a paused checkpoint's user turn, tool calls, partial text and a `paused` recovery update; 0.0.15 sends only the title `session_info_update`. The exception is converting a v1 session: if conversion takes over 150 ms or drops a file, fx sends `agent_message_chunk` notices such as "Converting this session from the previous session format…" (`core/session/session_adapter.zig:2876-2944`, `sessions.zig:1308-1318`). agetor drops content updates during the resume window (`replaying`) and during load (`suppressUpdates`), so those notices never reach the transcript. No change needed. The replay comments in `fx-acp.ts` become historical.
4. **Profile MCP servers run on a new MCP engine.** agetor opts in by default (`_meta.fx.profileMcpServers`). Legacy SSE servers no longer connect, local servers inherit only basic shell variables (any extra must be set in the fx MCP config), and authenticated HTTP servers need a fresh sign-in (release notes, Breaking Changes). The harness env map no longer reaches a profile MCP server through fx's environment. This needs a README note and nothing else.

**Changes agetor already handles, or that improve things with no code change:**

5. **Shell tool results are plain text** (`tool_call_presentation.zig:118-168`; S7): an optional notice, then the first 200 bytes of the output, then `\n... output truncated ...` when cut. The exit code moved out of the content. A non-zero exit still arrives as `status: "failed"`, which agetor renders as an error, and the code is in `command_result.exit_code` on the same update. Today's transcripts show 200 chars of JSON envelope instead. agetor's held-tool detection is unaffected: held and denied calls still carry the JSON error object (`core/tooling/tool_result_errors.zig` unchanged; `tool_call_presentation.zig:162-167` passes it through).
6. **A tool call left pending gets one final `failed` update when its turn ends** (`prompt.zig:421, 2220-2232`): "Cancelled", "Tool failed", "Tool state preserved for recovery" or "Tool completion was not reported". agetor maps `failed` to an error `tool_result` (`fx-acp.ts:1906-1921`), so those cards now close instead of staying open.
7. **Recovery meta lost `durable`** (`types.zig:43-92`) and gained the `delivering_response` action (libfx replay). The agetor parser treats `durable` as optional and already has the label (`src/shared/fx-recovery.ts:63, 156`).
8. **`clientCapabilities.session.notices` must be an object** (`server.zig:2638`; 0.0.14 accepted any non-null value). agetor sends `{}`.
9. **Every outgoing JSON-RPC frame is one line**: CR/LF inside JSON fx builds become spaces (`jsonrpc.zig:35-46`). This is a robustness fix for agetor's line reader.
10. Unchanged: `session/request_permission`, `session/cancel`, `session/set_config_option` (`effort`, `fast`, `ultrafast`), `session/set_mode` (still saves to `~/.fx/settings.json`; agetor never sends it), steering (64 KiB, absorbed/dropped, the -32600 text), the `stopReason` vocabulary, prompt `usage`, `_meta.fx.toolCall`, notices and the env vars agetor sets (`FX_PERMISSION_MODE`, `FX_REVIEW_MODEL`, `AI_GATEWAY_API_KEY`, `FX_AUTH_MODE`). `FX_SESSIONS_V2` and `FX_MCP_ENGINE` are gone; agetor sets neither. `ask_user_question` (now up to 20 questions) still never reaches an ACP client (`prompt.zig:564`, `interactive = false`). Duplicate client MCP server names are now rejected; agetor sends none.

### 1c. What did not change

Measured on both binaries in isolated HOMEs (§2, S3–S5):

- `fx --version` → `0.0.15`; `fx --help` still contains "coding agent" (`FX_HELP_MARKER`); the binary's minimum macOS is still 15.0 (`vtool -show-build`: `minos 15.0`, same as 0.0.14).
- `fx status --json`: identical key set (`auth`, `auth_help`, `auth_refreshable`, `permission_mode`, `mode`, `modes`, `mcp`, …). `auth: "missing"` + the same `auth_help` text unauthenticated.
- `fx models --json`: identical envelope (`kind, count, shown_count, more_count, private_models_hidden, ids, models`), `models[]` = `{id, name, efforts, fast, ultrafast}`, and an identical unauthenticated catalog: 263 ids, none added, removed or changed. The catalog comes from the Gateway, not the binary.
- `initialize`: same `protocolVersion: 1`, `agentCapabilities._meta.fx.steering: true`, `promptCapabilities {image: true, audio: false, embeddedContext: true}`, `sessionCapabilities {list, resume, close, systemPrompt}`. One difference: `mcpCapabilities` is now `{http: true, sse: false, acp: false}` (was all `true`). agetor sends `mcpServers: []`, so this doesn't matter.
- `session/new`: same 12-char session id shape and the same `configOptions` (`provider`, `model`, …).
- A refused turn (invalid key) still answers `{stopReason: "refused", usage: {}}` and delivers the reason as an `agent_message_chunk`.
- `fx upgrade` exists on both versions ("Upgrade fx on the selected release channel").

---

## 2. What we proved

| # | Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- | --- |
| S1 | Which model and mode hit `invalid_shell_request`? | **`zai/glm-5v-turbo`, Full access (`yolo`).** 2 events, both in run `a02d7082…` | `sqlite3 -readonly ~/.agetor/agetor.sqlite` over `run_events` + `tasks` | fx 0.0.14 | — |
| S2 | Does 0.0.15 remove the `request` wrapper from the shell schema the model receives, and how does each version answer a stringified `request`? | **Yes.** 0.0.14 schema: `properties: [request]`, `required: [request]`; 0.0.15: 12 top-level properties, `required: [action]`. Both reject the stringified call; both then run the corrected call. The model receives the full error (279 / 291 chars); the ACP client gets a 200-char preview | A fake OpenAI-compatible provider (`fake-llm.ts`, a custom `openai-chat-completions` connection in an isolated `~/.fx/settings.json`) replays glm-5v-turbo's call, then follows `retry_with`; `acp-turn.ts` drives one Full access ACP turn. No Gateway call, nothing billed | 0.0.14, 0.0.15 | `scratchpad/scripts/fake-llm.ts`, `acp-turn.ts`, `fake-014.log`, `fake-015.log` |
| S3 | Do `status --json` and `models --json` change? | **No.** Same keys; same 263 ids and the same per-model data | Python diff of both outputs | 0.0.14, 0.0.15, empty HOME | `scratchpad/models014.json`, `models015.json` |
| S4 | Do `initialize`, `session/new` and a refused prompt change? | **Only `mcpCapabilities`** (sse/acp now false) | `acp-probe.ts`, dummy `AI_GATEWAY_API_KEY` | 0.0.14, 0.0.15 | `scratchpad/scripts/acp-probe.ts` |
| S5 | Does a session created by 0.0.14 still `session/resume` on 0.0.15? | **Yes.** Resume returns `configOptions` and replays the title update; the store is converted (`~/.fx/sessions/` now holds `v2/` and `trash+v1/`) | `acp-resume.ts new` on 0.0.14, then `resume <id>` on 0.0.15, same isolated HOME | 0.0.14 → 0.0.15 | `scratchpad/scripts/acp-resume.ts` |
| S6 | What does `_meta.fx.continueRecovery` do on a plain ACP session in 0.0.15? | **-32602 "This session does not support durable recovery"** (0.0.14 reached the checkpoint lookup) | `acp-probe.ts` CONTINUE step | 0.0.14, 0.0.15 | same |
| S7 | What does a finished shell call carry over ACP? | **0.0.15: the command output** (`1\n2\n…70\n... output truncated ...`, 225 chars), plus `command_result.exit_code`; a non-zero exit is `status: "failed"`. **0.0.14: the first 200 chars of a JSON envelope** (`{"session_id":null,"state":"co…`) | `fake-llm-long.ts` runs `seq 1 400; exit 3` | 0.0.14, 0.0.15 | `scratchpad/scripts/fake-llm-long.ts`, `acp-turn-full.ts` |
| S8 | Can a session that never ran a turn be resumed from a new process? | **0.0.14: yes** (resume returns `configOptions`). **0.0.15: no**, resume and load both answer `{"code":-32602,"message":"Session not found"}` | `acp-resume2.ts newonly` (session/new, exit), then `resume <id>` | 0.0.14, 0.0.15 | `scratchpad/scripts/acp-resume2.ts` |

All scratchpad paths are under `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-ac75dfbe-d8f9-4264-a75c-ceb958afdd3e/a374fc91-0e86-48ea-98c5-7b2c30d6f5e1/scratchpad/`. The fx sources are in `scratchpad/fxsrc/v0.0.14`, `v0.0.15` and `main`; the 0.0.15 binary is `scratchpad/fx015bin/fx`.

---

## 3. What we're assuming

1. **Other weak models in agetor's fx list may stringify the wrapper too.** Only `glm-5v-turbo` was observed doing it. *If wrong:* nothing changes; the upgrade still removes the trigger.
2. **A model fed 0.0.15's flat schema doesn't invent a `request` wrapper.** This follows from the schema, but it wasn't run against `glm-5v-turbo` live: the owner's fx login lives in the macOS keychain, which an isolated HOME can't see, and running 0.0.15 against the real `~/.fx` would convert its session store. *If wrong:* the call still fails, with a clearer message, and the only fix left is a different model.
3. **No fx turn on 0.0.11–0.0.15 produces a resumable (`continue_later`) pause in ACP.** This is source-derived (`decide()` never returns `.pause`, and the TUI pause flag is never set in ACP) and was not run live. *If wrong:* a pause would show agetor's Resume, and on 0.0.15 Resume would fail with fx's "does not support durable recovery" text.
4. **A downgrade from 0.0.15 to 0.0.14 loses sessions created or opened on 0.0.15.** 0.0.15 never writes v1 files and leaves the old v1 folders in place. Not tested.

---

## 4. What we must ask the owner

1. **Upgrade this machine's fx now?** Run `fx upgrade` (or `curl -fsSL https://fx.sh/setup.sh | bash`). This fixes the reported shell errors with no agetor change. It converts each saved fx session to the v2 store the first time 0.0.15 opens it; see assumption 4 about going back. *Rec.:* yes.
2. **Fresh-session fallback (a real 0.0.15 regression, §1b.1).** When `session/resume` and `session/load` both answer -32602 "Session not found", should agetor start a new fx session for that turn and post a status line ("fx no longer has session X — starting a fresh session; earlier context didn't carry over")? This mirrors copilot's "not found for this account — starting fresh". *Rec.:* yes. Without it, one bad first turn leaves an fx task failing every follow-up.
3. **Recovery Resume / auto-resume on 0.0.15 (§1b.2).** (a) Keep it as is; it only applies to pauses fx ≤0.0.10 created, and on 0.0.15 it fails with fx's own text. (b) Gate it on the fx version: below 0.0.15 keep it, from 0.0.15 hide Resume, skip auto-resume and word the notice "send a new message to continue". (c) Remove the engine. *Rec.:* (b), or (a) plus a comment if minimal change is preferred. (c) also removes support for older binaries.
4. **Nudge users still on fx ≤0.0.14?** Add a `HarnessStatus.notices` line (the mechanism opencode uses) shown in Settings → Harnesses and `agetor harness ls`: "fx 0.0.14 and older can fail shell calls on some models — run `fx upgrade`". Also make `upgradeHintFor("fx")` return `fx upgrade` (present on 0.0.14 and 0.0.15) instead of the install script. *Rec.:* yes to both; they're cheap.
5. **Show the shell exit code?** 0.0.15 moved the exit code out of the result text into `command_result.exit_code`. agetor could append "exit N" to a failed shell result. *Rec.:* optional; a `failed` status already marks it.
6. **Raise the verified version to 0.0.15 and keep 0.0.4–0.0.14 working.** *Rec.:* yes. Nothing in §1b needs a version gate except item 3(b).

Answered from the code, not asked: the curated fx model list, the effort table and the default model need no change for this upgrade, because the catalog is the same 263 ids on both binaries.

---

## 5. Completeness inventory

| Surface | File | What changes |
| --- | --- | --- |
| Fresh-session fallback | `src/bun/fx-acp.ts` `runFxTurn` resume→load branch (`:2985-3058`) | On "Session not found" from both, fall through to `session/new` with a status line; `onSessionId` then records the new id |
| Resume gating (if 3b) | `src/bun/orchestrator.ts` `resumeFxRecovery`, `noteFxRunSettled`, `fireFxAutoResume`, `rearmFxAutoResumes`; `src/shared/fx-recovery.ts` `isFxRecoveryResumable`; RunPanel `PausedRecoveryNotice`; context menu `resume-recovery`; `agetor resume`; TUI `r` | Gate on the probed fx version (`cachedCliVersion`) |
| Version notice + upgrade hint | `src/bun/agent-status.ts` (`checkHarness` fx branch `:761`, `upgradeHintFor` `:92`) | Add a `< 0.0.15` notice; `fx upgrade` hint |
| Driver fact comments | `src/bun/fx-acp.ts` header facts blocks (46 mentions of 0.0.14) | Add a 0.0.15 block: lazy save, no resume replay, no `continueRecovery`, plain-text shell results, pending calls closed `failed`, no `durable` |
| Tests | `src/bun/fx-acp.test.ts` fake ACP server | Resume+load "Session not found" → fresh session; plain-text shell content; a final `failed` update for a pending call; `continueRecovery` -32602 on 0.0.15 |
| Docs | `CLAUDE.md` fx bullet ("Binary verified against …"), `README.md:116-122` ("tested with fx 0.0.4 through 0.0.14", MCP note) | Bump to 0.0.15; add the profile MCP engine note |

---

## 6. Runnability

Every probe ran against isolated HOMEs under the scratchpad, with a dummy `AI_GATEWAY_API_KEY` or a local fake model provider, so no Gateway call was made and nothing was billed. The investigation itself changed no source; the follow-up change and its test runs are in §8.

---

## 7. Risks & blast radius

- **The upgrade is one-way per session** (assumption 4). fx tasks keep their session ids, since conversion keeps the id.
- **Profile MCP servers that relied on inherited env vars, SSE or an existing HTTP login stop working** after the upgrade until reconfigured (§1b.4). This is the user's fx profile, not agetor config.
- **Without the fresh-session fallback,** any fx task whose first turn died before the turn began (expired login, a Stop during the handshake) fails every follow-up on 0.0.15 (§1b.1).

---

## 8. Decisions and what shipped (2026-10-28)

The owner answered §4:

| # | Decision | Shipped as |
| --- | --- | --- |
| 1 | Upgrade this machine's fx | `fx upgrade` → 0.0.15 (`7f2383af7098`); `fx status --json` still reads `auth: "fx login"` |
| 2 | Fresh-session fallback | `runFxTurn` (`src/bun/fx-acp.ts`): when `session/load` also answers -32602 "Session not found", post `fxSessionNotFoundStatus` and run the turn in a new `session/new`; `onSessionId` records the new id. Not on a `continueRecovery` turn |
| 3 | Gate Resume and auto-resume on fx ≥ 0.0.15 (option b) | `fxSupportsContinueRecovery` + `FX_RESUME_UNSUPPORTED_TEXT` (`src/shared/fx-recovery.ts`); `resumeFxRecovery` refuses (400) and clears the pause; `noteFxRunSettled` records none; `fireFxAutoResume` skips; `rearmFxAutoResumes` clears every persisted pause at boot (`tasks.listFxRecovery`); RunPanel shows the hint (`fx-recovery-unsupported`) instead of Resume and the countdown |
| 4 | Upgrade nudge | `FX_UPGRADE_NOTICE` in `HarnessStatus.notices` for a parseable fx below 0.0.15; `upgradeHintFor("fx")` → `fx upgrade` |
| 5 | Shell exit code | Not asked; left out (a `failed` status already marks it) |
| 6 | Verified version | 0.0.15, with 0.0.4–0.0.14 still supported |

Verified 2026-10-28: `bun run typecheck` clean; `bun test src/shared src/bun` 7189 pass, 0 fail; `src/cli/resume.test.ts` + `src/cli/commands/harness.test.ts` pass; e2e `fx-recovery.spec.ts` (15), `fx-harness-settings.spec.ts` (5) and `fx-models.spec.ts` pass. Tests: `src/bun/fx-acp.test.ts` (fallback, no fallback on continue-recovery), `src/shared/fx-recovery.test.ts` (`fxSupportsContinueRecovery`), `src/bun/agent-status.test.ts` (notice by version, `fx upgrade` hint), `src/bun/orchestrator-fx.test.ts` (manual Resume refused, boot sweep, settle on 0.0.15), `e2e/fx-recovery.spec.ts` (the hint replaces Resume on a 0.0.15 harness) and `e2e/fx-harness-settings.spec.ts` (the Settings notice). The e2e fx stub prints `$AGETOR_E2E_FX_VERSION` (default `0.0.4-fake`) for `--version`. Docs: `CLAUDE.md` fx bullet, `README.md` fx notes, the `src/bun/fx-acp.ts` header.
