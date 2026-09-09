import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { FxRecoveryPayload, FxUsagePayload, RunEventStream } from "../shared/types.ts";
import {
  FX_PROVIDER_STATUS_PREFIX,
  FX_RECOVERY_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_TURN_KEYS,
  FX_USAGE_STATUS_PREFIX,
  SESSION_DIED_STATUS_PREFIX,
} from "../shared/types.ts";
import { fxRecoverySummaryLine, parseFxRecoveryMeta } from "../shared/fx-recovery.ts";
import { isImagePath } from "../shared/attachments.ts";
import { SENT_FILES_TOOL_NAME } from "../shared/sent-files.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";
import {
  answerFxPermission,
  registerFxPermission,
  type FxPermissionAnswer,
  type FxPermissionOption,
  type FxPermissionToolCall,
} from "./interactions.ts";

/**
 * Driver for the `fx` agent kind — Vercel Labs' fx coding agent, driven via
 * `fx acp`, an Agent Client Protocol (ACP) server speaking newline-delimited
 * JSON-RPC 2.0 over stdio (one JSON object per line each direction).
 *
 * ── Architecture ──
 *
 * claude-tmux.ts / codex-tmux.ts / cursor-tmux.ts / gemini-tmux.ts each host
 * their CLI inside a *detached tmux session* so a turn survives an agetor
 * restart, and observe it indirectly (tailing a log file, or scraping a
 * pane). `fx acp` is a stateful RPC *server* over stdio instead: the moment
 * its stdin pipe or parent process disappears, its session is gone — there
 * is nothing on the other end to reattach to. So this driver spawns `fx acp`
 * as a **plain `Bun.spawn` child with piped stdio**, no tmux, one process
 * per turn, driven live over the pipe rather than tailed from a file:
 *
 *   - No `reattachFxSession` export, by design — see above. Boot
 *     reconciliation flips a still-`running` row to `orphaned` the same way
 *     it would for any other agent kind whose session vanished.
 *   - No on-disk log this driver reads: `--log-file` is fx's OWN debug log
 *     (for fx's own troubleshooting); this driver only ensures its parent
 *     directory exists.
 *   - `seenLineUuids` dedup still applies, matching the other three
 *     drivers, even though there's no reattach-replay path requiring it.
 *   - **Reaping**: every spawned child is tracked in `liveFxProcs`.
 *     `process.on("exit", …)` covers normal exit and Electrobun's
 *     `Utils.quit()` path; `SIGINT`/`SIGTERM`/`SIGHUP` handlers are always
 *     installed and always reap — but ownership of the *exit* is decided at
 *     signal-delivery time, not at module-load time (see the `FX_REAP_SIGNALS`
 *     comment below for why that distinction matters: `headless.ts` imports
 *     this module — and so registers these handlers — before it installs its
 *     own). A handler only calls `process.exit` itself when
 *     `process.listenerCount(sig) === 1` at the moment the signal arrives,
 *     i.e. it's the sole listener; otherwise some other (app-level) handler
 *     owns the shutdown sequence, and that handler is expected to call the
 *     exported `reapLiveFxProcs()` itself before it exits.
 *
 * ── Settlement invariant for carded (ask/auto) permission requests ──
 *
 * Exactly one reply is ever written for a given request id — `respondRpc` (or
 * its `respondCancelled` wrapper) never fires twice for the same id. For a
 * carded request, the awaiting `respondPermissionRequest` call is the sole
 * writer, once `registerFxPermission`'s `answer` promise resolves.
 * `cancelFxTurn`'s drain loop and `settleFx`'s card sweep never call
 * `respondRpc` for a carded id — only `answerFxPermission(cardId, {cancelled:
 * true})`, which *unblocks* that awaiting call rather than racing it. The
 * awaiting call is guarded twice after its `await`: if `state.resolved` is
 * already true it skips replying entirely (the stdin pipe may be
 * closing/closed); if `state.cancelRequested` is true a `selected` answer is
 * downgraded to `cancelled` (ACP's cancellation contract). `answerFxPermission`
 * returns `false` on an already-resolved id, so a card answered at the exact
 * moment Stop tears it down degrades to a no-op on whichever side loses the
 * race. The zero-options (uncarded) branch keeps the same invariant by
 * ordering rather than by construction: it `emit`s its "no options" status
 * line BEFORE calling `respondCancelled`, so if `emit` throws (e.g. `onChunk`
 * → `appendEvent` hitting a FK error against a since-deleted run) the
 * in-branch reply never fires and `handleServerRequest`'s catch-all fallback
 * writes the sole reply instead.
 *
 * ── Protocol index (verified against fx v0.0.4, v0.0.6, v0.0.7 and v0.0.8 —
 *    0.0.8 facts dated 2026-09-08: a binary probe of the v0.0.8 release, a
 *    full source-tarball diff v0.0.7…v0.0.8, and the same ACP probe re-run
 *    against the installed 0.0.7 binary to separate real 0.0.8 deltas from
 *    pre-existing 0.0.7 behavior — + ACP's canonical schema.json) ──
 *
 *   - `initialize`                  SPIKE-VERIFIED             handshake; unauth fails here (see describeHandshakeFailure)
 *   - `session/new`                 SPIKE-VERIFIED             → {sessionId, modes?, configOptions?}; mode nudge is best-effort (see runFxTurn)
 *   - `session/resume`/`load`       SCHEMA-DERIVED             resume falls back to load on -32601/-32602/-32600 alike (see runFxTurn)
 *   - `session/prompt`              SPIKE-VERIFIED shape       sole completion signal, no timeout (see runFxTurn); result gains a `usage` object as of 0.0.8
 *   - `session/update`              SPIKE-VERIFIED envelope    variant → chunk mapping (see mapFxUpdate); text deltas folded per message and (0.0.8+) per messageId (see FxTextCoalescer)
 *   - `session/request_permission`  LIVE-VERIFIED 0.0.8 (ask mode)  card flow  (see respondPermissionRequest)
 *   - `session/cancel`              SCHEMA-DERIVED             notification, no reply expected (see cancelFxTurn); 0.0.8 spike confirms it now actually interrupts in-flight work
 *   - death                         —                          unexpected exit before settlement (see the `exited` watcher)
 *
 * ── Facts verified against fx 0.0.5 through 0.0.8 (spike + release notes +
 *    Zig source diff; 0.0.5-0.0.7 facts dated 2026-08-31/09-01, 0.0.8 facts
 *    dated 2026-09-08 per the three-way verification named above) ──
 *
 *   - **No sandbox since 0.0.5** — fx retired its command sandbox; approved
 *     tool calls run as ordinary host subprocesses. Agetor's permission mode
 *     (`session/set_mode` + this driver's `session/request_permission`
 *     policy, see `respondPermissionRequest`) is the ONLY gate fx has left —
 *     there is no `sandbox_denied` outcome to parse and never was one here.
 *     Still true at 0.0.8 (0.0.7 even added an fx-side test asserting legacy
 *     `sandbox` settings keys stay inert); 0.0.8's tool inventory changed
 *     (see below) but the no-sandbox / permission-mode-is-the-only-gate
 *     model did not.
 *   - **Credential re-checks on `session/prompt` AND `session/resume`
 *     (0.0.5+; re-check paths unchanged through 0.0.8 — `jsonrpc.zig` is
 *     byte-identical 0.0.6→0.0.7→0.0.8; `server.zig` gained the new
 *     active-session gate in 0.0.8, see below, but the credential-recheck
 *     codepaths within it are unchanged)** — an unauthenticated/
 *     deauthorized binary no longer fails only at `initialize`; either call
 *     can return `-32600` mid-session with the same "fx needs access to
 *     Vercel AI Gateway…" text or a provider-specific variant (e.g. "fx
 *     needs a Codex subscription login for this model. Run fx login
 *     codex."), byte-identical through 0.0.8 (0.0.7 recased these from "Fx"
 *     to lowercase "fx" — cosmetic only). `-32600` is JSON-RPC's generic
 *     "Invalid Request" code, not an auth-specific one — fx merely reuses it
 *     for credential failures — so `session/resume`'s `-32600` is treated
 *     exactly like its `-32601`/`-32602` siblings in `runFxTurn`: it falls
 *     through to the `session/load` fallback rather than failing the turn
 *     immediately. If `session/load` in turn also answers `-32600`, that's
 *     authoritative either way it reads: the same credential gate, hit again
 *     (load can't do any better than resume did), or a non-auth "Invalid
 *     Request" (e.g. fx rejecting resume as unsupported) for which
 *     `session/load` is precisely the graceful path — so that catch surfaces
 *     fx's message verbatim via `RpcError.rawMessage`, with no `fx acp:
 *     failed to resume session…` wrapper. `session/prompt`'s `-32600` catch
 *     is unaffected by any of this — mid-turn there's nothing to fall back
 *     to, so it still fails the turn immediately, also surfacing fx's
 *     message verbatim via `rawMessage`. **Invalid vs. missing credential
 *     are different failures** (true on 0.0.7 and 0.0.8, spike-confirmed): a
 *     *missing* credential still fails at `initialize` with `-32600` as
 *     above, but an *invalid* (present but wrong) one does not —
 *     `session/new` succeeds and `session/prompt` instead resolves normally
 *     with `stopReason: "refused"`, delivering the reason (e.g.
 *     "AI_GATEWAY_API_KEY authentication failed · HTTP 401") as ordinary
 *     `agent_message_chunk` assistant prose rather than an RPC error — see
 *     the stopReason switch in `runFxTurn`, which surfaces `refused` on the
 *     shared "fx turn ended: …" status line same as any other non-`end_turn`
 *     stop.
 *   - **`configOptions` on `session/new`/`session/resume`/`session/load`
 *     results (0.0.5+, additive)** — a `{id, name, category, type,
 *     currentValue, options}[]` array; an entry with `id: "provider"` names
 *     the active auth provider (`"gateway"` | `"codex"` | `"grok"`). This
 *     driver emits its `currentValue` once per turn as a
 *     `FX_PROVIDER_STATUS_PREFIX` status chunk (see `maybeEmitProvider` in
 *     `runFxTurn`) — RunPanel renders it as a small provider chip. Absence
 *     (0.0.4 binaries, or a response that omits the array) is tolerated
 *     silently; no chip that turn. `src/acp/server.zig` is byte-identical
 *     0.0.6→0.0.7, and 0.0.8 keeps the same three provider values
 *     (spike-confirmed). **`provider`, `model` AND `mode` entries are ALL
 *     real wire entries, confirmed on 0.0.7 and 0.0.8 alike** — an earlier
 *     dossier claimed the mode/model entries were TUI-only strings a
 *     `strings` scan happened to pick up; that was wrong — that probe never
 *     got past an unauthenticated `initialize` far enough to see a real
 *     `session/new` result. `session/new` also returns a `modes` block whose
 *     `currentModeId` (and the `mode` configOptions entry's `currentValue`)
 *     reads `ask` regardless of `FX_PERMISSION_MODE` — that's just a display
 *     default. The session's EFFECTIVE permission mode is copied from
 *     startup config (`sessions.zig` `.permission_mode =
 *     state.permission_mode`), and `session/set_mode` overwrites it via
 *     `applySessionMode` (`code`→`auto`, `ask`→`ask`) — which is why
 *     `acpModeIdFor` below maps `auto`→`code`, `ask`→`ask`, and deliberately
 *     sends NO `session/set_mode` at all for `yolo` (see its own doc
 *     comment): a `code` nudge would DOWNGRADE yolo to `auto` rather than
 *     leaving it alone. Never add one.
 *   - **Eight `session/update` kinds are emitted as of 0.0.8** — up from six
 *     at 0.0.4/0.0.6/0.0.7 (`agent_message_chunk`, `user_message_chunk`,
 *     `tool_call`, `tool_call_update`, `available_commands_update`,
 *     `session_info_update`). 0.0.8 turns on the remaining two:
 *     **`agent_thought_chunk`** (reasoning deltas, `prompt.zig
 *     pushReasoningDelta`) and **`usage_update`** (once per completed turn,
 *     emitted right before the `session/prompt` response resolves, ONLY when
 *     the model's context window is known — `sessions.zig
 *     sendActiveSessionUsageUpdate`). Both were previously documented
 *     DORMANT (ACP-spec-correct `mapFxUpdate` branches fx never actually
 *     sent) and are now live; the mapping itself is unchanged, it's just no
 *     longer dormant. `plan` and `current_mode_update` still have no fx
 *     writer at 0.0.8 — their `mapFxUpdate` branches (the former feeds the
 *     TODO tracker) stay dormant.
 *   - **`session/prompt`'s result gains a `usage` object (0.0.8)** —
 *     `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *     reasoningTokens}`, each key present only when known (`{}` observed on
 *     a `refused` turn). `runFxTurn` reads it once the RPC resolves (before
 *     the stopReason switch) and — keeping only the finite-number fields —
 *     emits it as the `turn` half of the existing `FX_USAGE_STATUS_PREFIX`
 *     sentinel (`FxUsagePayload`, `src/shared/types.ts`); the `used`/`size`/
 *     `cost?` half still comes from the `usage_update` notification above.
 *     RunPanel shallow-merges every `fx-usage: ` sentinel it sees per run
 *     (see `src/mainview/lib/fx-usage.ts`), so the two halves can arrive as
 *     separate chunks in either order.
 *   - **`agent_message_chunk`/`user_message_chunk` carry a `messageId`
 *     (0.0.8)**, stable across one logical message and regenerated only at
 *     message-kind boundaries (`prompt.zig:171-183`) — `agent_thought_chunk`
 *     carries none observed today; tolerated as absent. `mapFxUpdate` reads
 *     it onto the mapped `assistant`/`thinking` chunk's `FxChunk.messageId`,
 *     and `FxTextCoalescer.push` treats a `messageId` change (when BOTH the
 *     buffered and incoming chunk carry a string id and they differ) as an
 *     additional flush boundary alongside the existing stream-kind switch —
 *     this is what lets two back-to-back same-stream messages split
 *     correctly instead of merging into one bubble, which the old
 *     stream-only heuristic couldn't do. Falls back to today's stream-only
 *     behavior whenever either side lacks an id (i.e. against 0.0.7 and
 *     earlier). `emit`/`deliver` never forward `messageId` to `onChunk` —
 *     `ChunkHandler`'s contract stays `(stream, data, lineUuid?)`.
 *   - **`tool_call` carries the real tool `name` plus inline `rawInput` on
 *     the initial update (0.0.8, `types.zig writeToolCall` signature
 *     change)** — `toolCallName` now prefers `update.name` when it's a
 *     non-empty string over the old `title (kind)` synthesis (still the
 *     fallback for a payload that omits `name`, i.e. 0.0.7 and earlier); the
 *     `tool_use` chunk's JSON payload gains an optional `title` field (fx's
 *     human-facing title, carried alongside the id-shaped `name` only when
 *     it differs from it) — RunPanel renders it muted after the tool name.
 *     Event dedup keys (`fx:tool:<id>:use`) are unchanged.
 *   - **`session_info_update` gained a `{title, updatedAt}` shape (0.0.8)**,
 *     fired at lifecycle points and after every turn — `mapFxUpdate` now has
 *     a dedicated branch for it (previously silently ignored, see the
 *     default case below): a non-empty `title`, normalized (whitespace
 *     collapsed and trimmed) and bounded at `FX_SESSION_TITLE_MAX_LEN` chars
 *     — fx session titles are model-generated text with no length guarantee
 *     — that isn't fx's "Untitled session" placeholder and differs from the
 *     last (normalized) title emitted this turn becomes one
 *     `FX_SESSION_TITLE_STATUS_PREFIX` status chunk (`fx-title: <title>`);
 *     RunPanel renders the latest one as a muted chip beside the provider
 *     chip. A `session_info_update` that carries no `title` field at all (an
 *     update whose only payload is `_meta.fx.modelResponseRecovery` — see
 *     the recovery-channel fact below — or any other titleless update) and
 *     a title that normalizes to empty both contribute nothing to THIS
 *     title logic specifically, though the same update may still have
 *     emitted a recovery chunk from the other, independent half of this
 *     branch.
 *   - **`session_info_update`'s `_meta.fx.modelResponseRecovery` retry
 *     -progress channel is LIVE, not legacy** — it ships alongside (not
 *     instead of) the `{title, updatedAt}` shape above, has been on the wire
 *     since fx 0.0.7, and is still live and unchanged at 0.0.8 (an earlier
 *     version of this file mislabeled it "the legacy pre-0.0.8 shape"; that
 *     was wrong — it's simply the OTHER thing this one update kind can
 *     carry, checked independently of `title` in `mapFxUpdate`'s
 *     `session_info_update` case). Per Gateway-retry attempt (twice — with
 *     and without `delaySeconds`) fx sends `{sessionUpdate:
 *     "session_info_update", _meta:{fx:{modelResponseRecovery:{state:
 *     "active", kind, cause, action, attempt, attemptLimit, delaySeconds?,
 *     durable, message}}}}`; a terminal `state:"paused"` once fx exhausts
 *     its retry budget (`requiredAction:"continue_later"` is the only
 *     variant Resume acts on); `state:"recovered"` when a retry succeeds;
 *     and `modelResponseRecovery:null` when fx drops the checkpoint. This
 *     driver maps it via `src/shared/fx-recovery.ts`'s `parseFxRecoveryMeta`
 *     to the `FX_RECOVERY_STATUS_PREFIX` sentinel (`src/shared/types.ts`),
 *     deduped against the last payload emitted this turn, plus a persisted,
 *     terminal-transition-only plain status line for `paused`/`recovered`
 *     (`fxRecoverySummaryLine`) — RunPanel derives a live progress notice
 *     and a Resume affordance from the sentinel stream, and the plain lines
 *     are what `agetor logs`/the TUI/the transcript show after the fact.
 *   - **`session/resume` REPLAYS session history — including a `paused`
 *     recovery update — onto the NEW run, before the resume response
 *     itself resolves.** `runFxTurn` flags `state.replaying` for exactly
 *     that window (see `FxSessionState.replaying`'s doc): the recovery
 *     sentinel above still emits during replay (so this run's own live
 *     state stays correct), but the terminal summary line does not — it
 *     already reached the transcript on the run where the pause/recovery
 *     genuinely happened, and re-firing it on every resume would spam a
 *     stale explanation into each follow-up. A replayed `paused` update
 *     specifically sets `state.replayedPaused`; the next NORMAL (non
 *     -continue) prompt sent on that session consumes fx's checkpoint
 *     (fx closes the interrupted turn the moment an ordinary prompt runs),
 *     so `runFxTurn` emits a `{state:"cleared"}` sentinel right before
 *     sending it — otherwise a stale Resume affordance could survive past
 *     a succeeded, unrelated follow-up turn.
 *   - **`continueRecovery` (fx ≥0.0.8) resumes a paused response without
 *     re-sending the prompt** — `FxLaunchOptions.continueRecovery: true`
 *     (requires `resumeSessionId`; checked in `runFxTurn` before any RPC
 *     traffic) sends `session/prompt` with an EMPTY `prompt: []` array plus
 *     `_meta:{fx:{continueRecovery:true}}` instead of new prompt text — fx
 *     rejects a continue call that also carries prompt content. A second
 *     continue against an already-consumed checkpoint, or a session that
 *     never supported durable recovery, answers `-32602` with fx's own
 *     user-actionable text ("No paused model response to continue", "This
 *     session does not support durable recovery", "Recovery continuation
 *     cannot include a new prompt") — surfaced verbatim via `RpcError
 *     .rawMessage`, the same treatment `-32600` credential failures get.
 *     A `refused` stop whose LIVE (non-replayed) recovery state is `paused`
 *     gets its status line enriched with the attempt count and "resumable"
 *     — see the stopReason switch in `runFxTurn`.
 *   - **Session ids are 12-char base64url as of 0.0.8** (`session_layout.zig`,
 *     down from 0.0.7's 50 characters) — 0.0.7's longer ids still validate
 *     and resume against a 0.0.8 binary, so a persisted `runs.fx_session_id`
 *     survives the machine upgrade with no migration.
 *   - **New security gate: the target session must be the process's active
 *     one (0.0.8)** — `session/prompt`/`cancel`/`set_mode`/
 *     `set_config_option` now all reject a `sessionId` that isn't the
 *     process's current session (`server.zig decideSessionTarget`). Agetor
 *     spawns exactly one `fx acp` child per turn, holding exactly one
 *     session, so this always resolves `.exact` — nothing for this driver to
 *     change.
 *   - **`initialize` leniency (0.0.8)** — `protocolVersion: 999` (a value fx
 *     doesn't recognize) is accepted rather than rejected; this driver keeps
 *     sending the number `1` regardless, so nothing here changes driver
 *     behavior (see the inline comment on the `initialize` call in
 *     `runFxTurn` — it used to also claim a *stringified* protocolVersion
 *     gets rejected with -32602, but that was never actually spike-verified;
 *     dropped). `promptCapabilities.image` in the `initialize` result is now
 *     `true` (was previously unset/false) — agetor's composer sends text +
 *     file references only, never an image content block, so this is inert
 *     for us too.
 *   - **Tool inventory changed (0.0.8)** — `memory`, `terminal`,
 *     `skill_search`, and `mcp_search_tools` were removed; `shell` (three
 *     actions: run/interact/stop), `capability_search`, and `subagent` (two
 *     actions: run/message) are the new/renamed set. This driver renders
 *     every `tool_call` generically regardless of tool identity (see
 *     `toolCallName`/`toolCallInput`), so the inventory change needs no
 *     driver code — noted here purely so a stale tool name in a transcript
 *     or test fixture isn't mistaken for a bug.
 *   - **`session/cancel` now actually stops the work (0.0.8)** — previously
 *     schema-derived and unverified whether fx honored it; the 0.0.8 spike
 *     confirms a cancelled turn's in-flight tool work stops rather than
 *     running to completion in the background. No driver change — this
 *     driver already treats `session/cancel` as fire-and-forget and races
 *     `session/prompt`'s own resolution (see `cancelFxTurn`).
 *   - **fx's wire `stopReason` strings never matched the ACP-canonical names
 *     this driver used to switch on (pre-existing bug, true on 0.0.7 and
 *     0.0.8 alike)** — fx's actual values are `end_turn`,
 *     `max_output_tokens`, `max_model_turns`, `refused`, `cancelled`
 *     (`types.zig StopReason`, byte-identical both versions); the driver's
 *     switch named `max_tokens`/`max_turn_requests`/`refusal` instead, so
 *     every such turn fell into the generic "unexpected stopReason" branch
 *     (still correctly `settleFx(state, 1)`, so no run was ever
 *     mis-recorded — only the status line's reason text was wrong). The
 *     switch in `runFxTurn` now accepts BOTH vocabularies — fx's real wire
 *     strings and the ACP-canonical names, the latter kept for forward
 *     compatibility.
 *   - **`FX_PERMISSION_MODE` still accepts exactly `yolo`/`auto`/`ask`
 *     (0.0.8)** — `--full-access`/`/permissions full-access` is 0.0.8's new
 *     UI/CLI wording for the same `.yolo` enum value
 *     (`config_runtime.zig parsePermissionMode`; fx's own README: "saved
 *     settings and JSON output retain `yolo`"); this driver keeps sending
 *     the env var value `yolo` (see `AGENT_OPTIONS.fx.modes` in
 *     `src/shared/types.ts` for the picker-facing "Full access" relabel —
 *     the stored id is unchanged).
 *   - **`agent_message_chunk` carries raw Markdown, not rendered text
 *     (0.0.7+, unchanged at 0.0.8)** — 0.0.6 streamed ANSI-stripped,
 *     already-rendered text and discarded the markdown source; 0.0.7 flips
 *     that (`src/acp/prompt.zig`): the chunk now carries the raw Markdown
 *     source instead, and a resumed response no longer repeats text already
 *     delivered. Neither needs a driver change here — chunks were already
 *     forwarded verbatim and rendered as markdown downstream by the webview.
 *   - **Project `.mcp.json` merges into ACP sessions (0.0.7+, unchanged at
 *     0.0.8)** — `session/new` AND `session/resume` merge the workspace's
 *     project-level `.mcp.json` MCP servers into the session (trust-gated by
 *     fx's own approval flow / `allow_acp_mcp`). This driver still passes
 *     `mcpServers: []` on every `session/new`/`session/load` call below, but
 *     a task `workdir` that itself carries a `.mcp.json` can still introduce
 *     MCP tools into the session via that merge — their `tool_call`s render
 *     generically like any other tool call; no driver change needed.
 *   - **`agent_message_chunk` is a token-level delta stream** — fx is the
 *     only agetor driver that streams sub-message deltas (claude's JSONL,
 *     codex's `item.completed`, gemini's `message` and cursor's `assistant`
 *     are all message-level). A live run against 0.0.7 (2026-09-01)
 *     delivered a ~400-char answer as 102 chunks ("This project", " is
 *     **Aget", "or** — a", …), and forwarding each as its own `assistant`
 *     event rendered one bubble per delta. `FxTextCoalescer` (which every
 *     `emit` routes through) buffers consecutive `assistant`/`thinking`
 *     deltas and delivers them as ONE event carrying the first delta's
 *     line_uuid, flushed by the next non-text chunk (a tool call, a status
 *     line), by a `messageId` change (0.0.8+, see above), by an inbound
 *     `session/request_permission` (`respondPermissionRequest`), and at
 *     settlement (`settleFx`).
 *   - **fx's `[context] …` diagnostics ride `agent_message_chunk`
 *     (unchanged at 0.0.8)** — ACP has no diagnostic channel, so 0.0.7's
 *     context-budget warnings (`[context] skill description "x" truncated:
 *     observed=… effective=1024 bytes …; override with --context-limit
 *     skill_description_bytes=BYTES|off`, plus the project-instructions /
 *     skill-catalog / MCP siblings a binary `strings` scan shows) arrive as
 *     the turn's first "message" chunk: one chunk, one `[context] ` line per
 *     warning. `mapFxUpdate` demotes a chunk made only of such lines to one
 *     `status` line each (`isFxContextDiagnostic`) instead of assistant
 *     prose. The override is a *global* `fx [--context-limit …] <command>`
 *     flag — `fx acp --context-limit …` is rejected by the subcommand's own
 *     usage check — so `AGETOR_FX_ARGS`, which lands after `acp`, cannot
 *     carry it today.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Small constants.
 * ────────────────────────────────────────────────────────────────────────── */

/** Timeout for every handshake RPC (`initialize`, `session/new`,
 *  `session/resume`, `session/load`) — NOT applied to `session/prompt`,
 *  which can legitimately run for a long time. */
const RPC_HANDSHAKE_TIMEOUT_MS = 30_000;
/** How long to let a cancelled turn's `session/prompt` response arrive on
 *  its own (with `stopReason: "cancelled"`) before we give up waiting and
 *  force-kill the process. */
const CANCEL_WAIT_MS = 3_000;
/** Grace between SIGTERM and SIGKILL when force-killing. */
const KILL_GRACE_MS = 2_000;
/** How many trailing stderr lines to keep for death diagnostics. */
const STDERR_RING_SIZE = 20;
/** Guard against a pathological unterminated line growing stdout's line
 *  buffer without bound — fx's own inbound cap is 8 MiB; ours is a looser
 *  backstop purely against a runaway/misbehaving process. Treated as death. */
const MAX_STDOUT_BUFFER_BYTES = 32 * 1024 * 1024;
/** Bound on a `session_info_update` title before it's emitted as the
 *  `FX_SESSION_TITLE_STATUS_PREFIX` sentinel — fx session titles are
 *  model-generated text with no length guarantee, same rationale as
 *  `extractFxProviderValue`'s 64-char provider-value bound below: an
 *  absurdly long title (bug, or a hostile/misbehaving fx binary) rides
 *  straight into a run-row chip with no truncation of its own. Exported for
 *  the mapper test. */
export const FX_SESSION_TITLE_MAX_LEN = 200;

/** Agetor's permission mode, as agents.ts passes it through. Narrowed
 *  locally (not reused from shared/types.ts) so the policy switch in
 *  `respondPermissionRequest` is exhaustive over exactly `yolo`/`auto`/
 *  `ask` — `AgentRunOptions.mode` itself stays `string | null`, same as
 *  every other agent kind. */
export type FxMode = "yolo" | "auto" | "ask";

/* ────────────────────────────────────────────────────────────────────────── *
 * Log-dir plumbing — fx owns and writes its own `--log-file`; we only make
 * sure the directory exists so `fx acp` doesn't fail to open it.
 * ────────────────────────────────────────────────────────────────────────── */

function ensureLogDirForArgv(argv: string[]): void {
  const idx = argv.indexOf("--log-file");
  if (idx === -1 || idx + 1 >= argv.length) return;
  const logFile = argv[idx + 1]!;
  const dir = path.dirname(logFile);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * JSON-RPC message shapes (loose — fx's actual payloads are the source of
 * truth; these are just enough structure to dispatch safely).
 * ────────────────────────────────────────────────────────────────────────── */

interface AcpEnvelope {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state.
 * ────────────────────────────────────────────────────────────────────────── */

interface FxSessionState {
  taskId: string;
  runId: string;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  mode: FxMode;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;

  nextRpcId: number;
  pending: Map<number, PendingRpc>;
  stdoutBuf: string;
  stderrRing: string[];

  sessionId: string | null;
  /** Set while a `session/load` fallback is awaiting its response, so the
   *  replayed `session/update` history it carries is discarded (the run's
   *  own persisted events already cover it). */
  suppressUpdates: boolean;
  /** ACP request id → interactions-registry card id, for every currently
   *  OPEN `fx_permission` card (ask/auto mode only — yolo/unknown-mode
   *  requests never register a card, they answer synchronously and never
   *  appear here). `cancelFxTurn`'s drain loop and `settleFx`'s card sweep
   *  use this to resolve the registry entry (`answerFxPermission`) instead
   *  of `respondRpc`-ing directly — see the file header's "Settlement
   *  invariant" note. Entries are removed by `respondPermissionRequest`
   *  itself once its `await answer` resolves. */
  cardIdByRequestId: Map<number | string, string>;
  seq: number;
  seenLineUuids: Set<string>;
  /** Folds `agent_message_chunk`/`agent_thought_chunk` deltas into whole
   *  messages — every chunk passes through it via `emit`; see the class
   *  doc for the flush boundaries. */
  coalescer: FxTextCoalescer;
  /** Last non-placeholder `session_info_update` title emitted this turn —
   *  carried forward across `dispatchSessionUpdate` calls (each of which
   *  builds a fresh `FxUpdateCtx`, since `mapFxUpdate` itself is otherwise
   *  pure) so a repeated identical title is deduped instead of re-emitted.
   *  See the `session_info_update` case in `mapFxUpdate` and the file
   *  header's session-title fact. */
  lastTitle?: string;
  /** JSON of the last `FX_RECOVERY_STATUS_PREFIX` sentinel body emitted this
   *  turn — carried forward across `dispatchSessionUpdate` calls the same
   *  way `lastTitle` is, so an identical consecutive recovery payload (fx
   *  resends the same `modelResponseRecovery` object more than once) is
   *  deduped instead of re-emitted. See the `session_info_update` case in
   *  `mapFxUpdate`. */
  lastRecoveryJson?: string;
  /** True from the moment `session/resume` is sent until its response
   *  settles (success or error) — see `runFxTurn`. fx replays the session's
   *  prior `session/update` history (including a `paused` recovery update)
   *  onto the NEW run while this is true; the sentinel still emits (so the
   *  live-state derivation on the new run stays correct) but the terminal
   *  paused/recovered summary line does not — that line already reached the
   *  transcript on the run where the pause actually happened, and re-firing
   *  it on every resume would spam a stale explanation into every follow-up
   *  turn. */
  replaying?: boolean;
  /** Set when a `paused` recovery update arrives while `replaying` is true
   *  — i.e. `session/resume` replayed a paused checkpoint onto this run.
   *  Read once, right before a NORMAL (non-`continueRecovery`) prompt is
   *  sent: fx consumes the checkpoint the moment an ordinary prompt runs
   *  (`prompt.zig` closes the interrupted turn), so `runFxTurn` emits a
   *  `{state:"cleared"}` sentinel and resets this flag first — otherwise a
   *  succeeded follow-up turn would still show a stale Resume affordance
   *  from the replayed pause. */
  replayedPaused?: boolean;
  /** The last NON-replayed recovery payload observed this turn (i.e. one
   *  that arrived live, not via `session/resume`'s history replay) — read by
   *  the `refused`/`refusal` stopReason branch to enrich the "fx turn
   *  ended: …" status line when this run itself is the one that paused. */
  lastRecovery?: FxRecoveryPayload;
  /** True once this turn has already emitted the "held tool call" guidance
   *  status line (see the `tool_call_update` case in `mapFxUpdate`) — caps
   *  it at one per run even if fx holds several tool calls in a row for the
   *  same reason. */
  reviewHeldWarned?: boolean;

  resolved: boolean;
  killRequested: boolean;
  /** Set the moment a cancel is requested — from then on, any inbound
   *  `session/request_permission` (including one racing the cancel drain or
   *  arriving during the post-cancel grace window) is answered `cancelled`
   *  instead of going through the normal allow/reject policy, per ACP's
   *  cancellation contract. */
  cancelRequested: boolean;
  resolveDone: (code: number) => void;
  /** Resolves the moment `resolveDone` fires — the same promise returned to
   *  the caller as `SpawnedAgent.done`, kept on state as well so
   *  `waitUntilResolved` can race it instead of polling. */
  done: Promise<number>;
}

const fxSessions = new Map<string, FxSessionState>(); // taskId -> state

/** Every currently-spawned `fx acp` child, tracked so a mid-turn agetor exit
 *  doesn't leak an orphaned process (see the file header's "Architecture"
 *  section — a bare child does NOT die with its parent on POSIX). Registered
 *  in `spawnFxViaAcp`, unregistered in `settleFx`. */
const liveFxProcs = new Set<Subprocess<"pipe", "pipe", "pipe">>();

export function reapLiveFxProcs(): void {
  for (const proc of liveFxProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

process.on("exit", reapLiveFxProcs);

// Belt-and-suspenders for the signals `exit` doesn't cover: Node/Bun's
// default handler for SIGINT/SIGTERM/SIGHUP terminates the process WITHOUT
// running "exit" listeners, so a bare Ctrl-C on `bun run dev` (SIGINT) or a
// plain `kill`/service-manager stop (SIGTERM/SIGHUP) would otherwise leak a
// still-running `fx acp` child with write access to the task's worktree.
//
// Ownership of the *exit* is decided at SIGNAL-DELIVERY time, not at
// module-load time. Module import order runs this file's top-level code (and
// so registers these handlers) before an app-level shutdown owner gets a
// chance to register its own — e.g. `headless.ts` imports
// orchestrator → agents → fx-acp before `runDaemon()` installs its own
// SIGINT/SIGTERM handlers, so checking `listenerCount(sig) === 0` at module
// load always found this the sole listener and always exited here first,
// pre-empting `headless.ts`'s `shutdown()` (which removes the core creds file
// and logs a "shutting down" line) from ever running. Instead: install
// unconditionally, always reap, and only call `process.exit` when — AT THE
// MOMENT THE SIGNAL FIRES — `process.listenerCount(sig) === 1`, i.e. this is
// still the only listener. When another handler is also registered for the
// signal, that handler owns the shutdown sequence; it is expected to call the
// exported `reapLiveFxProcs()` itself before it exits (see `headless.ts`'s
// `shutdown()`). This repo has no OTHER app-level quit handler today besides
// `headless.ts` (Electrobun's confirm-on-quit path calls `Utils.quit()`,
// which DOES fire "exit" and is covered by the hook above), but any future
// one is likewise free to become the sole owner of a signal's shutdown
// sequence without racing this one.
const FX_REAP_SIGNALS: Array<[NodeJS.Signals, number]> = [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
];
for (const [sig, num] of FX_REAP_SIGNALS) {
  process.on(sig, () => {
    reapLiveFxProcs();
    if (process.listenerCount(sig) === 1) process.exit(128 + num);
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Wire I/O.
 * ────────────────────────────────────────────────────────────────────────── */

function writeMessage(state: FxSessionState, msg: Record<string, unknown>): void {
  try {
    state.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    state.proc.stdin.flush();
  } catch {
    // Pipe already closed — the process is dead or dying. The `exited`
    // watcher (installed in spawnFxViaAcp) settles the turn; nothing to do
    // here beyond not throwing out of a fire-and-forget write.
  }
}

function sendRpc(state: FxSessionState, method: string, params: unknown): Promise<unknown> {
  const id = state.nextRpcId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    writeMessage(state, { jsonrpc: "2.0", id, method, params });
  });
}

function sendNotification(state: FxSessionState, method: string, params?: unknown): void {
  writeMessage(state, { jsonrpc: "2.0", method, params });
}

function respondRpc(state: FxSessionState, id: number | string, result: unknown): void {
  writeMessage(state, { jsonrpc: "2.0", id, result });
}

function respondRpcError(state: FxSessionState, id: number | string, code: number, message: string): void {
  writeMessage(state, { jsonrpc: "2.0", id, error: { code, message } });
}

/** Shorthand for the `outcome: "cancelled"` reply every reject-fast path in
 *  the permission flow sends — the shared terminal answer for a moot,
 *  unanswerable, or already-settled request. */
function respondCancelled(state: FxSessionState, id: number | string): void {
  respondRpc(state, id, { outcome: { outcome: "cancelled" } });
}

/** Try each kind in `preferredKinds`, in order, and answer `selected` with
 *  the first option whose `kind` matches; if none match, answer `cancelled`
 *  — unless `fallbackToFirstOption` is set, in which case any offered
 *  option (regardless of kind) is taken rather than cancelling outright.
 *  Shared by the yolo (`allow_once` → `allow_always` → any option) and
 *  fail-closed (`reject_once` → `reject_always` → cancelled, deliberately
 *  no first-option fallback — an unrecognized request must never silently
 *  become an allow) synchronous-answer arms of the permission policy. */
function answerByKind(
  state: FxSessionState,
  id: number | string,
  options: Array<{ optionId: string; kind?: string }>,
  preferredKinds: string[],
  fallbackToFirstOption = false,
): void {
  let chosen: { optionId: string; kind?: string } | undefined;
  for (const kind of preferredKinds) {
    chosen = options.find((o) => o.kind === kind);
    if (chosen) break;
  }
  if (!chosen && fallbackToFirstOption) chosen = options[0];
  if (chosen) {
    respondRpc(state, id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
  } else {
    respondCancelled(state, id);
  }
}

/** Thrown only by `withTimeout`'s own timer — never by fx. Distinguishing it
 *  by class (not by matching the message text) is what lets `isTimeoutError`
 *  tell "we gave up waiting" apart from an fx-supplied error whose message
 *  happens to start with the same words (see `isTimeoutError`). */
class RpcTimeoutError extends Error {}

/** Rejection shape for a real JSON-RPC error reply from fx (as opposed to
 *  `RpcTimeoutError`, which is ours). `code` is the JSON-RPC error code —
 *  callers use it to distinguish a credential re-check failure (`-32600`,
 *  see the header's "Facts verified against fx 0.0.5 through 0.0.8" section)
 *  from every other protocol error, without re-parsing `message`. The message
 *  text itself is UNCHANGED from before this class existed
 *  (`"<fx message> (code <n>)"`) so every existing message-based assertion
 *  still holds — `code` is purely additive. `rawMessage` is fx's error
 *  message BYTE-FOR-BYTE, with no `(code <n>)` suffix appended — callers
 *  that need to surface fx's own text verbatim (the `session/load` and
 *  `session/prompt` `-32600` catches in `runFxTurn`) read `rawMessage`
 *  instead of `message`. Falls back to the composed `message` on the rare
 *  reply that omits `error.message` entirely. */
class RpcError extends Error {
  code: number | undefined;
  rawMessage: string;
  constructor(message: string, code: number | undefined, rawMessage?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.rawMessage = rawMessage ?? message;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(`timed out waiting for ${label} (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Emit a chunk through the run's `line_uuid` dedup gate, mirroring the other
 *  drivers' `seenLineUuids` pattern (see cursor-tmux.ts / gemini-tmux.ts),
 *  then through the session's `FxTextCoalescer`: an `assistant`/`thinking`
 *  delta is buffered rather than delivered, and any other chunk first
 *  flushes whatever text is buffered ahead of itself — so every non-text
 *  event (a status line, a tool call, fx's own diagnostics) lands *after*
 *  the prose that preceded it, exactly as the wire ordered them, and that
 *  prose lands as ONE event. `flushText` is the explicit counterpart for
 *  the message boundaries that aren't chunks: an inbound permission
 *  request and settlement. */
function emit(
  state: FxSessionState,
  stream: RunEventStream,
  data: string,
  lineUuid?: string,
  // ACP `messageId` (fx ≥0.0.8) — consumed by the coalescer's flush-on-change
  // rule only; `deliver` never forwards it (ChunkHandler is (stream, data, lineUuid)).
  messageId?: string,
): void {
  // A settled turn emits nothing: pumpStdout keeps dispatching whatever
  // lines remain in the pipe until SIGTERM actually closes the stream, and
  // those trailing updates would otherwise append events to a run the
  // orchestrator has already finalized (or, post-delete, to a missing row).
  if (state.resolved) return;
  if (lineUuid) {
    if (state.seenLineUuids.has(lineUuid)) return;
    state.seenLineUuids.add(lineUuid);
  }
  deliver(state, state.coalescer.push({ stream, data, lineUuid, messageId }));
}

/** Deliver whatever text the coalescer is holding — a no-op when it holds
 *  nothing. Same settled-turn gate as `emit`. */
function flushText(state: FxSessionState): void {
  if (state.resolved) return;
  deliver(state, state.coalescer.flush());
}

function deliver(state: FxSessionState, chunks: FxChunk[]): void {
  for (const c of chunks) state.onChunk(c.stream, c.data, c.lineUuid);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Inbound line dispatch.
 * ────────────────────────────────────────────────────────────────────────── */

function handleLine(state: FxSessionState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: AcpEnvelope;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    emit(state, "status", `fx acp: malformed line from stdout: ${trimmed.slice(0, 200)}`);
    return;
  }

  const hasId = msg.id !== undefined;
  const isReply = hasId && ("result" in msg || "error" in msg);
  if (isReply) {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = state.pending.get(id);
    if (!pending) return; // stale/unknown id — ignore
    state.pending.delete(id);
    if (msg.error) {
      const rawMessage = msg.error.message ?? "fx acp error";
      pending.reject(
        new RpcError(`${rawMessage} (code ${msg.error.code ?? "?"})`, msg.error.code, rawMessage),
      );
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (typeof msg.method === "string" && hasId) {
    handleServerRequest(state, msg.method, msg.id!, msg.params);
    return;
  }

  if (typeof msg.method === "string") {
    handleServerNotification(state, msg.method, msg.params);
    return;
  }

  // Neither a reply, a request, nor a notification — forward-compat ignore.
}

function handleServerRequest(state: FxSessionState, method: string, id: number | string, params: unknown): void {
  if (method === "session/request_permission") {
    // `void`d because ask/auto mode now `await`s a card answer that may take
    // arbitrarily long (a human, not a promise that resolves this tick) —
    // handleServerRequest itself must stay synchronous so the stdout pump
    // (single-threaded line dispatch loop) never stalls behind an open card
    // while later lines (including a RACING session/cancel notification's
    // effects) keep arriving. A carded (ask/auto) request's id lands in
    // `cardIdByRequestId` synchronously, inside respondPermissionRequest,
    // before its `await answer` — that's the only bookkeeping a later
    // cancelFxTurn/settleFx sweep needs; a non-carded (yolo/unknown) request
    // answers synchronously with no await in between, so it's never still
    // pending by the time a sweep could run.
    //
    // Fail closed: `registerFxPermission`'s synchronous broadcast to SSE
    // listeners can throw through an arbitrary listener callback, and a
    // thrown rejection here must never strand fx awaiting a reply that will
    // now never come. Answer `cancelled` and drop the request's bookkeeping
    // so a later cancelFxTurn/settleFx sweep doesn't try to resolve an id
    // that's already dead.
    void respondPermissionRequest(
      state,
      id,
      params as
        | {
            options?: Array<{ optionId: string; name?: string; kind?: string }>;
            toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
          }
        | undefined,
    ).catch((err) => {
      emit(state, "status", `fx acp: permission handling failed: ${errMessage(err)}`);
      respondCancelled(state, id);
      state.cardIdByRequestId.delete(id);
    });
    return;
  }
  // fx advertised no fs/terminal capabilities at `initialize` — it
  // shouldn't ask for them, but don't silently ignore it if it does.
  emit(state, "status", `fx acp: unsupported request from agent: ${method}`);
  respondRpcError(state, id, -32601, "Method not found");
}

async function respondPermissionRequest(
  state: FxSessionState,
  id: number | string,
  params:
    | {
        options?: Array<{ optionId: string; name?: string; kind?: string }>;
        toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
      }
    | undefined,
): Promise<void> {
  // A request that arrives once cancellation is underway (or after the turn
  // already settled) must not be policy-answered — in auto/yolo mode the
  // permissive arm would authorize fx to START a new tool action in the
  // middle of a user-initiated Stop. ACP's cancellation contract is that the
  // client answers such requests with outcome "cancelled". Checked BEFORE
  // ever registering a card — no card should exist for a request that's
  // already moot.
  if (state.cancelRequested || state.resolved) {
    respondCancelled(state, id);
    return;
  }

  // A permission request is a message boundary: the prose fx streamed
  // before asking ("I'll run X…") must be on the transcript before the
  // card (or an auto-answer's consequences) shows up, not only once the
  // whole turn ends. Whichever mode answers below, this ordering holds.
  flushText(state);

  const options = Array.isArray(params?.options) ? params!.options! : [];

  // Live caveat (fx 0.0.8, 2026-09-08): in `auto` mode fx runs its OWN
  // review first, hard-wired to `openai/gpt-5.6-luna`; on an account that
  // gets HTTP 403 for that tier fx answers `decision=unavailable →
  // deny, recovery=agent_replan` and tells the model the action was held —
  // it does NOT escalate a `session/request_permission`, so this handler
  // never runs and no card appears. `ask` mode was verified live the same
  // day (options allow_once / allow_always / reject_once), and `yolo` ran
  // the tool with no request at all.
  if (state.mode === "yolo") {
    // Prefer allow_once over allow_always so an approval stays scoped to
    // this turn instead of writing a durable rule into the user's fx
    // config; falls back to any offered option rather than cancelling —
    // yolo never surfaces a card.
    answerByKind(state, id, options, ["allow_once", "allow_always"], true);
    return;
  }

  if (state.mode !== "auto" && state.mode !== "ask") {
    // Fail-closed: any unknown/future mode id takes the reject arm and
    // never surfaces a card, with no first-option fallback.
    answerByKind(state, id, options, ["reject_once", "reject_always"]);
    return;
  }

  // ask AND auto both card — auto does not auto-allow. Register an
  // fx_permission card and await its answer instead of answering
  // synchronously. `toolCall`/`options` are sanitized down to exactly the
  // fields the card needs; only `toolCallId` is guaranteed on the wire per
  // ACP's schema, so every other field is optional-checked.
  const rawToolCall = params?.toolCall;
  const toolCall: FxPermissionToolCall = {
    toolCallId: typeof rawToolCall?.toolCallId === "string" ? rawToolCall.toolCallId : "unknown",
    title: typeof rawToolCall?.title === "string" ? rawToolCall.title : undefined,
    kind: typeof rawToolCall?.kind === "string" ? rawToolCall.kind : undefined,
    rawInput: rawToolCall && "rawInput" in rawToolCall ? rawToolCall.rawInput : undefined,
  };
  const cardOptions: FxPermissionOption[] = options.map((o) => ({
    optionId: o.optionId,
    name: typeof o.name === "string" && o.name.length > 0 ? o.name : o.optionId,
    kind: o.kind,
  }));

  // ACP's schema only guarantees `toolCallId` on this request — `options`
  // may be absent or empty, and this file never trusts that silently. An
  // unanswerable card (nothing for the user to click) must never register;
  // answer cancelled up front instead, and say so out loud so a silent
  // cancel is diagnosable rather than looking like the card vanished.
  if (cardOptions.length === 0) {
    // Emit BEFORE replying: if `emit` throws (`onChunk` → `appendEvent` can,
    // e.g. a FK error against a since-deleted run), the reply below must
    // never have gone out yet, so `handleServerRequest`'s catch-all fallback
    // is the only thing that replies — see the file header's "Settlement
    // invariant" note. Reversing this order would let both this call and the
    // catch-all's `respondCancelled` write a reply for the same id.
    emit(state, "status", "fx acp: permission request had no options — auto-cancelled");
    respondCancelled(state, id);
    return;
  }

  const { id: cardId, answer } = registerFxPermission({
    taskId: state.taskId,
    runId: state.runId,
    toolCall,
    options: cardOptions,
    mode: state.mode,
  });
  state.cardIdByRequestId.set(id, cardId);

  let answer_: FxPermissionAnswer;
  try {
    answer_ = await answer;
  } finally {
    // Whatever the outcome, this id no longer has an open card once the
    // promise settles — remove it BEFORE the state.resolved check below so
    // a concurrent cancelFxTurn/settleFx sweep racing this same tick never
    // sees (and tries to re-resolve) an id whose card has already resolved.
    state.cardIdByRequestId.delete(id);
  }

  // The turn may have settled (death, cancel-timeout force-kill, or a
  // same-tick turn-end) WHILE this card was open — the stdin pipe backing
  // `respondRpc` may already be closing/closed by the time the await above
  // returns, so a resolution arriving after settlement must not attempt a
  // reply at all (see header: Settlement invariant).
  if (state.resolved) {
    return;
  }

  // A selected answer landing during cancellation must NOT become outcome
  // "selected" — ACP's contract is that every pending request answers
  // cancelled once session/cancel is sent, and a card answer racing that
  // (e.g. the HTTP answer route resolving just before cancelFxTurn's drain
  // loop reaches this id) must still lose to the cancellation.
  if (state.cancelRequested) {
    respondCancelled(state, id);
    return;
  }

  if ("cancelled" in answer_ && answer_.cancelled) {
    respondCancelled(state, id);
  } else if ("optionId" in answer_ && cardOptions.some((o) => o.optionId === answer_.optionId)) {
    // Belt-and-suspenders — the HTTP answer route validates the optionId
    // against the same request before ever calling `answerFxPermission`,
    // but a second check here costs nothing and means this driver never
    // trusts a value it didn't itself offer.
    respondRpc(state, id, { outcome: { outcome: "selected", optionId: answer_.optionId } });
  } else {
    respondCancelled(state, id);
  }
}

function handleServerNotification(state: FxSessionState, method: string, params: unknown): void {
  if (method !== "session/update") return; // forward-compat ignore
  if (state.suppressUpdates) return; // discarding replay during session/load fallback
  const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
  if (update) dispatchSessionUpdate(state, update);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * session/update → chunk mapping.
 * ────────────────────────────────────────────────────────────────────────── */

interface AcpContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Concatenate text content blocks. Accepts either a single block object (the
 *  schema's documented shape for chunk updates) or an array of blocks
 *  defensively, and ignores any non-text block rather than erroring. */
function extractText(content: unknown): string {
  if (!content) return "";
  const blocks: AcpContentBlock[] = Array.isArray(content) ? content : [content as AcpContentBlock];
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** The `tool_use` chunk's `name` field. fx ≥0.0.8's `tool_call` update
 *  carries the real tool id (`shell`, `capability_search`, `subagent`, …) in
 *  `update.name` — prefer it when present. Falls back to the pre-0.0.8
 *  `title (kind)` synthesis for a payload that omits `name` (0.0.7 and
 *  earlier, or a forward-compat gap). The human-facing `title`, when it
 *  differs from whichever name wins here, rides alongside as the `tool_use`
 *  payload's own `title` field (see the `tool_call` case below) rather than
 *  being folded into this string. */
function toolCallName(update: Record<string, unknown>): string {
  const name = typeof update.name === "string" && update.name.length > 0 ? update.name : null;
  if (name) return name;
  const title = typeof update.title === "string" && update.title.length > 0 ? update.title : null;
  const kind = typeof update.kind === "string" && update.kind.length > 0 ? update.kind : null;
  if (title && kind) return `${title} (${kind})`;
  return title ?? kind ?? "tool_call";
}

/** Generic, forward-compat payload for a tool_use chunk — mirrors cursor's
 *  approach of forwarding the inner payload as-is rather than picking apart
 *  a shape that's explicitly unstable across fx versions. Prefers
 *  `rawInput` when present (the closest fx gets to a stable "what were the
 *  args" field); falls back to the whole update otherwise. */
function toolCallInput(update: Record<string, unknown>): unknown {
  if ("rawInput" in update) return update.rawInput;
  return update;
}

/** Same idea for the terminal tool_result payload — prefers `rawOutput`,
 *  then `content`, then the whole update. */
function toolResultContent(update: Record<string, unknown>): unknown {
  if ("rawOutput" in update) return update.rawOutput;
  if ("content" in update) return update.content;
  return update;
}

/**
 * Best-effort detection of fx's review-held/permission-denied error shape
 * inside a completed-or-failed tool call's result content — see the
 * `tool_call_update` case's "Held-tool guidance" comment for the wire shape
 * and why this exists. `content` is whatever {@link toolResultContent}
 * produced for the paired `tool_result` chunk: usually a plain string (fx's
 * `toolUpdateContentText` serializes the error object to JSON text for the
 * model), but this also tolerates an already-parsed plain object in case a
 * future fx build stops stringifying it. Never throws — a non-string,
 * non-object `content`, a string that isn't valid JSON, or a parsed value
 * with no `error` object all yield `undefined`, which the caller reads the
 * same as "not a review-held error" rather than a `type`/`reason` it has to
 * separately null-check.
 */
function fxToolReviewError(content: unknown): { type?: unknown; reason?: unknown } | undefined {
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const err = (parsed as Record<string, unknown>).error;
  if (!err || typeof err !== "object" || Array.isArray(err)) return undefined;
  return err as { type?: unknown; reason?: unknown };
}

/** One `file://` `resource_link` content block found in a completed tool
 *  call's `content` array — see {@link extractFxResourceLinks}. */
interface FxResourceLink {
  path: string;
  mimeType: string | null;
  size: number | null;
}

/**
 * Pull every `file://` `resource_link` out of a `ToolCallUpdate.content`
 * array (ACP schema: `ToolCallContent[]`, each either `{ type: "content",
 * content: ContentBlock }`, `{ type: "diff", … }` or `{ type: "terminal",
 * … }`). Only `{ type: "content", content: { type: "resource_link", uri,
 * … } }` items are relevant — diff/terminal entries and any other
 * `ContentBlock` variant (`text`, `image`, …) are ignored — and only a
 * `file://` `uri` converts to a local path (http(s)/data/other schemes
 * aren't something `SendUserFile` can represent, so those links are
 * dropped rather than mapped). An unparsable `uri` (malformed URL) is
 * skipped individually rather than failing the whole array — one bad link
 * shouldn't hide the rest.
 */
function extractFxResourceLinks(content: unknown): FxResourceLink[] {
  if (!Array.isArray(content)) return [];
  const out: FxResourceLink[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const wrapper = item as Record<string, unknown>;
    if (wrapper.type !== "content") continue;
    const block = wrapper.content;
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "resource_link") continue;
    if (typeof b.uri !== "string" || !b.uri.startsWith("file://")) continue;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(new URL(b.uri).pathname);
    } catch {
      continue;
    }

    const mimeType = typeof b.mimeType === "string" && b.mimeType.trim().length > 0 ? b.mimeType.trim() : null;
    const size = typeof b.size === "number" && Number.isFinite(b.size) && b.size >= 0 ? b.size : null;
    out.push({ path: decodedPath, mimeType, size });
  }
  return out;
}

/** A chunk `mapFxUpdate` wants emitted — the pure equivalent of an `emit()`
 *  call, minus the dedup/settled-turn gating `emit` itself applies.
 *  `messageId` (fx ≥0.0.8, `agent_message_chunk`/`agent_thought_chunk` only
 *  — `agent_thought_chunk` carries none observed today) is consumed
 *  entirely internally by `FxTextCoalescer` to decide flush boundaries; it
 *  is never forwarded to `onChunk` (`emit`/`deliver` only ever read
 *  `stream`/`data`/`lineUuid` off a chunk) — `ChunkHandler`'s contract stays
 *  `(stream, data, lineUuid?)`. */
export interface FxChunk {
  stream: RunEventStream;
  data: string;
  lineUuid?: string;
  messageId?: string;
}

/** fx tags its human-facing context-budget diagnostics with this prefix
 *  (`[context] skill description "x" truncated: observed=… effective=1024
 *  bytes …; override with --context-limit skill_description_bytes=BYTES|off`,
 *  plus the project-instructions / skill-catalog / MCP siblings a binary
 *  `strings` scan shows) and — ACP having no diagnostic channel — ships them
 *  as the turn's first `agent_message_chunk`, one chunk with one line per
 *  warning. Observed live against 0.0.7 (2026-09-01); unchanged at 0.0.8
 *  (spike + source diff, 2026-09-08). */
export const FX_CONTEXT_DIAGNOSTIC_PREFIX = "[context] ";

/** True when every non-blank line of `text` is one of fx's `[context] …`
 *  diagnostics — i.e. the whole chunk is a diagnostics block, not prose.
 *  Deliberately all-or-nothing: a model answer that merely *mentions* a
 *  `[context]` line, or a chunk that mixes prose with one, stays prose. */
export function isFxContextDiagnostic(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => line.trimStart().startsWith(FX_CONTEXT_DIAGNOSTIC_PREFIX));
}

/** The two streams whose chunks are token-level *deltas* of one logical
 *  message rather than whole events. */
type FxTextStream = "assistant" | "thinking";

/**
 * Folds fx's sub-message deltas back into whole messages. fx is the only
 * agetor driver that streams token-level deltas — claude's JSONL, codex's
 * `item.completed`, gemini's `message` and cursor's `assistant` events are
 * all message-level — and forwarding each delta as its own `assistant`
 * event persisted a ~400-char answer as 102 `run_events` rows that RunPanel
 * rendered as one bubble per delta ("This project", " is **Aget", "or** —
 * a", …). This buffers consecutive same-stream deltas and hands them back
 * as ONE chunk carrying the *first* delta's line uuid (unique per run, so
 * the `(run_id, line_uuid)` dedup index still holds).
 *
 * Message boundaries — where `push` flushes on its own: a delta on the
 * *other* text stream (assistant → thinking or back); a `messageId` change
 * (fx ≥0.0.8 — when BOTH the buffered chunk and the incoming one carry a
 * string `messageId` and they differ, see `prompt.zig:171-183`'s
 * regenerate-at-message-boundary rule; a 0.0.7 stream, which carries no
 * `messageId` at all, falls back to the stream-switch rule alone, same as
 * before this existed); and any non-text chunk (tool_use/tool_result/
 * status/…), which is delivered *after* the flushed text so wire order is
 * preserved. Boundaries that aren't chunks (an inbound
 * `session/request_permission`, settlement) call `flush` explicitly via
 * `flushText`.
 *
 * Pure and exported for the same reason `mapFxUpdate` is: unit-testable
 * without a child process (see fx-acp-mapper.test.ts).
 *
 * Asymmetry: the buffered `messageId` is captured from a message's FIRST
 * delta only (`push`, the `this.stream === null` branch below) — if that
 * first delta lacks an id but a later delta in the same message carries
 * one, the buffer stays id-less and `messageIdChanged` can never trip for
 * it. Unreachable against fx 0.0.8 (every `agent_message_chunk` delta
 * carries the id), and fails safe if it ever did happen: the deltas merge
 * into one bubble rather than being over-split into two.
 */
export class FxTextCoalescer {
  private stream: FxTextStream | null = null;
  private text = "";
  private lineUuid: string | undefined;
  private messageId: string | undefined;

  /** Feed one mapped chunk; returns the chunks now ready to deliver, in
   *  order (possibly none — a buffered delta returns `[]`). */
  push(chunk: FxChunk): FxChunk[] {
    if (chunk.stream === "assistant" || chunk.stream === "thinking") {
      const streamChanged = this.stream !== null && this.stream !== chunk.stream;
      const messageIdChanged =
        this.stream !== null &&
        typeof this.messageId === "string" &&
        typeof chunk.messageId === "string" &&
        this.messageId !== chunk.messageId;
      const out = streamChanged || messageIdChanged ? this.flush() : [];
      if (this.stream === null) {
        this.stream = chunk.stream;
        this.lineUuid = chunk.lineUuid;
        this.messageId = chunk.messageId;
      }
      this.text += chunk.data;
      return out;
    }
    return [...this.flush(), chunk];
  }

  /** Hand back the buffered message (if any) and reset. */
  flush(): FxChunk[] {
    if (this.stream === null) return [];
    const out: FxChunk = { stream: this.stream, data: this.text, lineUuid: this.lineUuid };
    this.stream = null;
    this.text = "";
    this.lineUuid = undefined;
    this.messageId = undefined;
    return [out];
  }

  /** True while a message is buffered and not yet flushed. */
  get pending(): boolean {
    return this.stream !== null;
  }
}

/** Context threaded through `mapFxUpdate` — `runId`/`nextSeq` are the
 *  existing seq/line_uuid plumbing (`nextSeq` stands in for the stateful
 *  `state.seq++` the inline version used; callers pass `() => state.seq++`
 *  to keep the sequence shared across a whole run). `lastTitle` is the one
 *  piece of genuine cross-call state `mapFxUpdate` needs: the last
 *  non-placeholder `session_info_update` title it emitted, read AND mutated
 *  by that branch to dedupe a repeated identical title. `mapFxUpdate` itself
 *  stays otherwise pure — a caller that wants the dedupe to actually work
 *  across a run's updates (rather than per-call) must pass the SAME ctx
 *  object to every `mapFxUpdate` call for that run, or otherwise carry
 *  `lastTitle` forward itself (see `dispatchSessionUpdate`, which does the
 *  latter against `FxSessionState.lastTitle`). The five recovery/review
 *  fields below mirror that same pattern one-for-one against
 *  `FxSessionState.lastRecoveryJson`/`replaying`/`replayedPaused`/
 *  `lastRecovery`/`reviewHeldWarned` — see those fields' doc comments on
 *  `FxSessionState` for what each one means; `dispatchSessionUpdate` reads
 *  all five off `state` into a fresh `ctx` before every `mapFxUpdate` call
 *  and writes all five back afterwards, exactly like `lastTitle`. */
export interface FxUpdateCtx {
  runId: string;
  nextSeq: () => number;
  lastTitle?: string;
  lastRecoveryJson?: string;
  replaying?: boolean;
  replayedPaused?: boolean;
  lastRecovery?: FxRecoveryPayload;
  reviewHeldWarned?: boolean;
}

/**
 * Pure `session/update` → chunk(s) mapper — mirrors `mapCodexEvent` /
 * `mapCursorEvent` / `mapGeminiEvent` being exported, side-effect-free
 * functions the fake-server driver tests don't need to spawn a child to
 * exercise.
 */
export function mapFxUpdate(update: Record<string, unknown>, ctx: FxUpdateCtx): FxChunk[] {
  const kind = update.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (!text) return [];
      // fx's context-budget diagnostics ride this same stream (see
      // FX_CONTEXT_DIAGNOSTIC_PREFIX) and would otherwise render as the
      // model's opening paragraph. Demote a diagnostics-only chunk to one
      // `status` line per warning; the seq counter still advances per line
      // so every line_uuid stays unique within the run. Diagnostic lines
      // never carry a `messageId` — they're not real assistant prose, and
      // `status`-stream chunks bypass the coalescer's messageId-flush logic
      // entirely (see FxTextCoalescer.push).
      if (isFxContextDiagnostic(text)) {
        return text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map((line) => ({ stream: "status" as const, data: line, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}` }));
      }
      // messageId (fx ≥0.0.8) is stable across one logical message and
      // regenerated only at message-kind boundaries — threaded onto the
      // chunk so FxTextCoalescer can split back-to-back same-stream
      // messages it otherwise couldn't tell apart. Absent on 0.0.7 and
      // earlier; tolerated as undefined.
      const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
      return [{ stream: "assistant", data: text, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`, messageId }];
    }

    case "agent_thought_chunk": {
      const text = extractText(update.content);
      if (!text) return [];
      // No messageId observed on this variant to date (see the file
      // header) — read defensively the same way, in case fx starts sending
      // one; absence is tolerated identically to the assistant branch.
      const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
      return [{ stream: "thinking", data: text, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`, messageId }];
    }

    case "tool_call": {
      const id =
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : // No real id to correlate a later tool_call_update against —
            // still worth emitting (a seq-based id renders fine on its
            // own), it just can never pair with a result (see the
            // tool_call_update branch).
            `seq${ctx.nextSeq()}`;
      const name = toolCallName(update);
      // fx's human-facing `title`, carried alongside `name` only when it
      // actually adds information: fx ≥0.0.8 puts the real tool id in
      // `name` (see toolCallName), so the title is a separate fact worth
      // keeping; on a pre-0.0.8 update with no `name` the fallback already
      // folds the title into the `title (kind)` name string, so carrying it
      // again would just render it twice.
      const hasRealName = typeof update.name === "string" && update.name.length > 0;
      const rawTitle = typeof update.title === "string" && update.title.length > 0 ? update.title : undefined;
      const title = hasRealName && rawTitle && rawTitle !== name ? rawTitle : undefined;
      return [
        {
          stream: "tool_use",
          data: JSON.stringify({ id, name, input: toolCallInput(update), serverSide: false, title }),
          lineUuid: `fx:tool:${id}:use`,
        },
      ];
    }

    case "tool_call_update": {
      const status = update.status;
      if (status !== "completed" && status !== "failed") return []; // pending/in_progress — ignore
      // Without a real toolCallId there is nothing to pair this result with
      // the tool_use it completes — minting an independent seq-based id here
      // would never match the use event's id (different seq counter state),
      // so drop the event rather than emit an unpairable orphan.
      if (typeof update.toolCallId !== "string") return [];
      const id = update.toolCallId;
      const resultContent = toolResultContent(update);
      const chunks: FxChunk[] = [
        {
          stream: "tool_result",
          data: JSON.stringify({ toolUseId: id, content: resultContent, isError: status === "failed" }),
          lineUuid: `fx:tool:${id}:result`,
        },
      ];

      // ── Held-tool guidance ──
      // fx's hard-wired auto-mode reviewer can be unavailable on an account
      // (e.g. HTTP 403 for that tier — see `respondPermissionRequest`'s
      // "Live caveat" comment on `session/request_permission`), in which
      // case fx never escalates a permission request at all: it just holds
      // or denies the call and tells the MODEL why, as a JSON error object
      // riding the same content
      // this tool_result's `content` field above was just built from —
      // `{"error":{"type":"tool_review_held"|"tool_permission_denied",
      // "reason":"review_unavailable", …}}`. Surface that to the USER too,
      // once per run (`ctx.reviewHeldWarned`), so they know to switch modes
      // rather than watch every tool call silently fail. Any other error
      // shape/reason (a real permission denial, an unrelated tool failure)
      // emits nothing here — this is guidance for one specific, otherwise
      // silent failure mode, not a generic error reporter.
      if (!ctx.reviewHeldWarned) {
        const reviewError = fxToolReviewError(resultContent);
        if (
          reviewError &&
          (reviewError.type === "tool_review_held" || reviewError.type === "tool_permission_denied") &&
          reviewError.reason === "review_unavailable"
        ) {
          ctx.reviewHeldWarned = true;
          chunks.push({
            stream: "status",
            data:
              "⚠ fx held this tool call — its safety reviewer (auto mode) is unavailable on this account, so tools can't run. Switch this task's mode to Full access (or Ask) to let tools run.",
            lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
          });
        }
      }

      // ── Dormant: `resource_link` → synthetic `SendUserFile` tool_use/result ──
      // fx 0.0.7's ACP implementation, source- and binary-string-verified
      // 2026-09-07, emits only `text`/`image` content blocks — never
      // `resource_link` — so this branch has no live fx traffic to exercise
      // it today. It's spec-correct scaffolding, the same bet as the `plan`
      // → `TodoWrite` and `usage_update` → status-chip mappings above: the
      // ACP schema lets a completed tool call's `content` carry
      // `{ type: "content", content: { type: "resource_link", uri, … } }`
      // items describing files the tool produced or delivered, and if a
      // future fx build (or another ACP-speaking harness this driver might
      // one day serve) starts sending them, agetor should render that
      // exactly like Claude's own `SendUserFile` tool — one shared
      // card/badge/CLI line (`src/shared/sent-files.ts`), not a bespoke
      // ACP-only surface. Only completed calls qualify (a failed call's
      // links, if any, describe files that were never actually delivered);
      // only `file://` URIs convert to a local path — `SendUserFile` is
      // inherently about local filesystem delivery. Emitted strictly AFTER
      // the real tool_result above so wire order is preserved (the tool's
      // own result renders before the derived "files sent" pair).
      if (status === "completed" && Array.isArray(update.content)) {
        const links = extractFxResourceLinks(update.content);
        if (links.length > 0) {
          const sentFilesId = `${id}:sent-files`;
          const title = typeof update.title === "string" ? update.title.trim() : "";
          const input: Record<string, unknown> = { files: links.map((l) => l.path), status: "normal" };
          if (title.length > 0) input.caption = title;
          chunks.push({
            stream: "tool_use",
            data: JSON.stringify({ id: sentFilesId, name: SENT_FILES_TOOL_NAME, input, serverSide: false }),
            lineUuid: `fx:tool:${id}:sent-files:use`,
          });

          const n = links.length;
          chunks.push({
            stream: "tool_result",
            data: JSON.stringify({
              toolUseId: sentFilesId,
              content: `${n} file${n === 1 ? "" : "s"} delivered to user.`,
              isError: false,
              attachments: links.map((l) => ({
                path: l.path,
                size: l.size,
                isImage: l.mimeType !== null ? l.mimeType.startsWith("image/") : isImagePath(l.path),
                mediaType: l.mimeType,
              })),
            }),
            lineUuid: `fx:tool:${id}:sent-files:result`,
          });
        }
      }

      return chunks;
    }

    case "plan": {
      // Full snapshot semantics (ACP: "client replaces the entire plan with
      // each update") — mirrors legacy TodoWrite exactly, so this rides the
      // existing TODO tracker (shared/todo-progress.ts) with zero new UI.
      // A non-array `entries` is malformed — ignore the whole update rather
      // than emit a bogus empty list (which would read as an explicit
      // clear, a different thing). An actual empty array IS a valid
      // explicit clear and must still emit.
      const rawEntries = (update as { entries?: unknown }).entries;
      if (!Array.isArray(rawEntries)) return [];
      const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
      for (const raw of rawEntries) {
        // Individual malformed entries are dropped, not fatal to the rest
        // of the snapshot — mirrors coerceTodoItem's per-item tolerance in
        // shared/todo-progress.ts (which also re-coerces this same payload
        // downstream, so this is belt-and-suspenders, not the only guard).
        if (raw == null || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.content !== "string" || r.content.trim() === "") continue;
        const status =
          r.status === "pending" || r.status === "in_progress" || r.status === "completed" ? r.status : "pending";
        // `priority` is intentionally dropped — the TODO tracker has no
        // priority concept (recorded as a known reduction in the plan doc).
        todos.push({ content: r.content, status });
      }
      return [
        {
          stream: "tool_use",
          data: JSON.stringify({ id: "fx-plan", name: "TodoWrite", input: { todos }, serverSide: false }),
          lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
        },
      ];
    }

    case "usage_update": {
      const used = (update as { used?: unknown }).used;
      const size = (update as { size?: unknown }).size;
      // Missing/non-numeric used|size is malformed — ignore silently rather
      // than emit a chip with holes in it.
      if (typeof used !== "number" || typeof size !== "number") return [];
      const rawCost = (update as { cost?: unknown }).cost;
      let cost: { amount: number; currency: string } | undefined;
      if (rawCost != null && typeof rawCost === "object") {
        const c = rawCost as Record<string, unknown>;
        if (typeof c.amount === "number" && typeof c.currency === "string") {
          cost = { amount: c.amount, currency: c.currency };
        }
        // A malformed cost object is dropped on its own — used/size still
        // emit rather than losing the whole update over an optional field.
      }
      return [
        {
          stream: "status",
          data: FX_USAGE_STATUS_PREFIX + JSON.stringify({ used, size, ...(cost ? { cost } : {}) }),
          lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
        },
      ];
    }

    case "session_info_update": {
      // Two independent facts can ride this one update kind — fx's retry
      // -progress channel (`_meta.fx.modelResponseRecovery`, live since
      // 0.0.7) and the `{title, updatedAt}` session-title shape (fx ≥0.0.8,
      // see the file header) — checked and emitted separately below, in
      // that order, so an update carrying both (or either alone) is handled
      // the same way regardless of which fields are present.
      const chunks: FxChunk[] = [];

      // ── Recovery channel ──
      // `parseFxRecoveryMeta` returns `undefined` when this update carries
      // no `_meta.fx.modelResponseRecovery` key at all (most updates —
      // nothing to do here), or a payload (possibly `{state:"cleared"}` for
      // the wire's explicit `null`) when it does. Dedup against the last
      // payload JSON emitted THIS turn (`ctx.lastRecoveryJson`, mirroring
      // `ctx.lastTitle`'s dedupe) — an identical consecutive payload emits
      // nothing at all, not even a repeated sentinel.
      const recovery = parseFxRecoveryMeta(update);
      if (recovery != null) {
        const recoveryJson = JSON.stringify(recovery);
        if (recoveryJson !== ctx.lastRecoveryJson) {
          ctx.lastRecoveryJson = recoveryJson;
          chunks.push({
            stream: "status",
            data: FX_RECOVERY_STATUS_PREFIX + recoveryJson,
            lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
          });
          if (ctx.replaying) {
            // session/resume replaying this session's prior history onto a
            // NEW run — the sentinel above still lands (so this run's live
            // state derivation is correct), but the terminal summary line
            // below is suppressed: it already reached the transcript on the
            // run where the pause/recovery actually happened. A replayed
            // `paused` update specifically also flags `replayedPaused`, read
            // by `runFxTurn` right before it sends a normal follow-up prompt
            // (see the file header + `FxSessionState.replayedPaused`).
            if (recovery.state === "paused") ctx.replayedPaused = true;
          } else {
            // A live (non-replayed) update — record it for the `refused`/
            // `refusal` stopReason branch to enrich its status line when
            // THIS run is the one that paused, and emit the persisted,
            // terminal-transition-only summary line (paused/recovered only
            // — `fxRecoverySummaryLine` returns `null` for `active`/
            // `cleared`, nothing final to say yet).
            ctx.lastRecovery = recovery;
            const summary = fxRecoverySummaryLine(recovery);
            if (summary !== null) {
              chunks.push({ stream: "status", data: summary, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}` });
            }
          }
        }
      }

      // ── Session title ──
      // {title, updatedAt} (fx ≥0.0.8), fired at lifecycle points and after
      // every turn — see the file header. Normalize before every check:
      // collapse all whitespace (newlines/tabs/repeated spaces) to a single
      // space, trim, then bound at FX_SESSION_TITLE_MAX_LEN — fx session
      // titles are model-generated text with no length guarantee, mirroring
      // extractFxProviderValue's 64-char provider-value bound below. The
      // placeholder/dedupe checks run against the NORMALIZED title: fx's own
      // placeholder ("Untitled session"), a recovery-only update (no
      // `title` field at all — the two facts above are independent, and an
      // update can carry the recovery meta without ever carrying a title),
      // and a title that normalizes to empty all carry no usable TITLE and
      // so contribute nothing here (though the update may still have
      // emitted a recovery chunk above); a repeat of the same normalized
      // title already emitted this turn (via `ctx.lastTitle`, mutated
      // below) is deduped rather than re-emitted.
      const rawTitle = (update as { title?: unknown }).title;
      if (typeof rawTitle === "string" && rawTitle.length > 0) {
        const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, FX_SESSION_TITLE_MAX_LEN);
        if (title && title !== "Untitled session" && title !== ctx.lastTitle) {
          ctx.lastTitle = title;
          chunks.push({
            stream: "status",
            data: FX_SESSION_TITLE_STATUS_PREFIX + title,
            lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
          });
        }
      }

      return chunks;
    }

    default:
      // current_mode_update, available_commands_update, user_message_chunk,
      // config_option_update, and any future variant — silent forward-compat
      // (v1 scope).
      return [];
  }
}

/** `dispatchSessionUpdate` is the stateful adapter around the pure
 *  `mapFxUpdate`: it supplies `ctx` from the session's own runId/seq
 *  counter (plus `lastTitle`, read from and written back to
 *  `state.lastTitle` so the `session_info_update` dedupe persists across
 *  calls — see `FxSessionState.lastTitle`) and routes every resulting chunk
 *  through `emit` (dedup + settled-turn gating), same as before the
 *  extraction. */
function dispatchSessionUpdate(state: FxSessionState, update: Record<string, unknown>): void {
  const ctx: FxUpdateCtx = {
    runId: state.runId,
    nextSeq: () => state.seq++,
    lastTitle: state.lastTitle,
    lastRecoveryJson: state.lastRecoveryJson,
    replaying: state.replaying,
    replayedPaused: state.replayedPaused,
    lastRecovery: state.lastRecovery,
    reviewHeldWarned: state.reviewHeldWarned,
  };
  for (const c of mapFxUpdate(update, ctx)) {
    emit(state, c.stream, c.data, c.lineUuid, c.messageId);
  }
  state.lastTitle = ctx.lastTitle;
  state.lastRecoveryJson = ctx.lastRecoveryJson;
  state.replaying = ctx.replaying;
  state.replayedPaused = ctx.replayedPaused;
  state.lastRecovery = ctx.lastRecovery;
  state.reviewHeldWarned = ctx.reviewHeldWarned;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * stdout/stderr pumps.
 * ────────────────────────────────────────────────────────────────────────── */

async function pumpStdout(state: FxSessionState): Promise<void> {
  const stream = state.proc.stdout;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.stdoutBuf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = state.stdoutBuf.indexOf("\n")) >= 0) {
        const line = state.stdoutBuf.slice(0, nl);
        state.stdoutBuf = state.stdoutBuf.slice(nl + 1);
        handleLine(state, line);
      }
      // `stdoutBuf.length` is UTF-16 code units, not bytes — comparing it
      // directly against a byte-denominated cap under-triggers for
      // multi-byte UTF-8 text. A UTF-8 char is at most 4 bytes → at most ~3x
      // the UTF-16 units it can produce (surrogate pairs are 2 units for up
      // to 4 bytes), so `length` is always >= `byteLength / 3`; that makes
      // `length * 3 >= MAX` a cheap, always-safe pre-check before paying for
      // the exact `Buffer.byteLength` computation.
      if (
        state.stdoutBuf.length * 3 >= MAX_STDOUT_BUFFER_BYTES &&
        Buffer.byteLength(state.stdoutBuf, "utf8") > MAX_STDOUT_BUFFER_BYTES
      ) {
        failTurn(state, `${SESSION_DIED_STATUS_PREFIX}fx stdout exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes without a newline`);
        return;
      }
    }
  } catch {
    // Stream closed — normal on process exit; the `exited` watcher handles
    // settlement.
  }
}

async function pumpStderr(state: FxSessionState): Promise<void> {
  const stream = state.proc.stderr;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        state.stderrRing.push(trimmed);
        if (state.stderrRing.length > STDERR_RING_SIZE) state.stderrRing.shift();
      }
    }
  } catch {
    // noop — stderr closing is normal on exit.
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Turn settlement.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Settle the turn, exactly once. This is also where the child process gets
 * torn down on the SUCCESS path: fx's "one session per connection" model
 * (see file header) means each `spawnFxViaAcp` call is a one-shot process
 * for exactly one turn — nothing reuses this connection afterwards (a
 * follow-up turn spawns an entirely new process with `resumeSessionId`
 * set), so leaving the process alive past settlement would leak it. The
 * failure paths already call `killProc` themselves before reaching here
 * (so the process is dead before the failure status chunk is even
 * observable); calling it again here is a no-op there via `killRequested`.
 */
function settleFx(state: FxSessionState, code: number): void {
  if (state.resolved) return;
  // Last chance for buffered prose: an `end_turn` (or a cancel, or a death)
  // arrives with the message's trailing deltas still in the coalescer,
  // since nothing after them ever forced a flush. Wrapped because a
  // throwing `onChunk` (e.g. `appendEvent` against a since-deleted run)
  // must never keep the process alive or the session registered.
  try {
    flushText(state);
  } catch {
    /* settlement proceeds regardless */
  }
  state.resolved = true;
  // Identity-checked: a cross-kind agent switch or a fresh turn on the same
  // task can already have replaced this taskId's map entry with a newer
  // state by the time this (older) state settles — an unconditional delete
  // would unregister the wrong (still-live) session.
  if (fxSessions.get(state.taskId) === state) fxSessions.delete(state.taskId);
  liveFxProcs.delete(state.proc);
  killProc(state);
  // Sweep any still-open fx_permission card so it never outlives the
  // driver — process death mid-card (the most common way settleFx runs
  // without ever going through cancelFxTurn's drain loop) would otherwise
  // leak a registry entry the UI keeps showing a card for forever (see
  // header: Settlement invariant).
  for (const cardId of state.cardIdByRequestId.values()) {
    answerFxPermission(cardId, { cancelled: true });
  }
  state.cardIdByRequestId.clear();
  for (const pending of state.pending.values()) pending.reject(new Error("fx session settled"));
  state.pending.clear();
  state.resolveDone(code);
}

/** Emit a status chunk then settle failed, but only once — every failure
 *  path in this file funnels through here so a timeout/death/protocol-error
 *  race can't double-fire. `settleFx` itself terminates the process. */
function failTurn(state: FxSessionState, message: string): void {
  if (state.resolved) return;
  emit(state, "status", message);
  settleFx(state, 1);
}

function killProc(state: FxSessionState): void {
  if (state.killRequested) return;
  state.killRequested = true;
  try { state.proc.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    try { state.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  state.proc.exited.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
}

/** Wait for the turn to settle, or `timeoutMs` to elapse — whichever comes
 *  first. Races `state.done` (resolved the instant `settleFx` runs, via
 *  `resolveDone`) against a timer, rather than polling `state.resolved` on
 *  an interval. The timer handle is hoisted so it can be cleared once the
 *  race settles — otherwise a turn that resolves before `timeoutMs` elapses
 *  leaves a live timer behind for the remainder of the timeout window. */
async function waitUntilResolved(state: FxSessionState, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([state.done, timeout]);
  clearTimeout(timer!);
}

/**
 * Interrupt an in-flight fx turn: notify fx via `session/cancel`, answer any
 * pending inbound permission request as `cancelled` so fx isn't stuck
 * waiting on us, give the pending `session/prompt` a few seconds to resolve
 * with `stopReason: "cancelled"` on its own, then force-kill if it hasn't.
 */
async function cancelFxTurn(state: FxSessionState): Promise<void> {
  if (state.resolved) return;
  state.cancelRequested = true;
  if (state.sessionId) sendNotification(state, "session/cancel", { sessionId: state.sessionId });
  // Drain every still-open carded (ask/auto) permission request through the
  // registry (see header: Settlement invariant) — a non-carded (yolo/
  // unknown) request answers synchronously with no await in between, so it
  // can never still be pending by the time this runs; `cardIdByRequestId`
  // alone is a complete picture. Snapshot to an array first since the map
  // isn't mutated inline here — that happens in respondPermissionRequest
  // once its await resolves.
  for (const cardId of Array.from(state.cardIdByRequestId.values())) {
    answerFxPermission(cardId, { cancelled: true });
  }

  await waitUntilResolved(state, CANCEL_WAIT_MS);
  if (!state.resolved) {
    killProc(state);
    // The orchestrator derives cancelled-vs-failed from its own
    // `handle.cancelled` flag (see cursor-tmux.ts's identical comment on
    // `killCursorState`) — the code passed here is immaterial to the
    // recorded run status.
    settleFx(state, 1);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The ACP conversation itself: handshake → (new | resume | load) → prompt.
 * ────────────────────────────────────────────────────────────────────────── */

/** Maps agetor's permission mode to the mode id for the best-effort
 *  post-`session/new` `session/set_mode` nudge (see `runFxTurn`): `auto` →
 *  `code`, `ask` → `ask`. Returns `null` for `yolo` ON PURPOSE and this must
 *  never change: fx's `session/set_mode` OVERWRITES the session's effective
 *  permission mode (`applySessionMode`: `code`→`auto`, `ask`→`ask`) — there
 *  is no mode id that means yolo, so a `code` nudge sent while in yolo would
 *  DOWNGRADE it to `auto` rather than leaving it alone. Sending nothing at
 *  all is what lets yolo's startup-config permission mode
 *  (`FX_PERMISSION_MODE=yolo` → `sessions.zig .permission_mode`) survive
 *  untouched. See the file header's configOptions fact for the full
 *  source-level rationale — never add a yolo branch here. */
function acpModeIdFor(mode: FxMode): string | null {
  if (mode === "auto") return "code";
  if (mode === "ask") return "ask";
  return null; // yolo — no session/set_mode call
}

/** Pull the active provider id out of a `session/new`/`session/resume`/
 *  `session/load` result's `configOptions` array (0.0.5+, additive — see
 *  the file header's "Facts verified against fx 0.0.5 through 0.0.8"
 *  section). Pure and exported for the same reason `mapFxUpdate` is: unit-testable
 *  against a raw result object without spawning a child. Tolerates a
 *  missing/non-array `configOptions` (0.0.4 binaries, or a response that
 *  omits it) and any entry shape ACP's schema doesn't guarantee — returns
 *  `null` rather than throwing. */
export function extractFxProviderValue(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const configOptions = (result as { configOptions?: unknown }).configOptions;
  if (!Array.isArray(configOptions)) return null;
  for (const entry of configOptions) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const currentValue = (entry as { currentValue?: unknown }).currentValue;
    // Bounded: this string rides straight into a run-row chip with no
    // truncation of its own — an absurdly long value (bug, or a hostile/
    // misbehaving fx binary) would blow out the chip's layout, so anything
    // over 64 chars is treated the same as absent.
    if (
      id === "provider" &&
      typeof currentValue === "string" &&
      currentValue.length > 0 &&
      currentValue.length <= 64
    ) {
      return currentValue;
    }
  }
  return null;
}

/** Reads `session/prompt`'s (fx ≥0.0.8) `usage` object and, if at least one
 *  of `FX_TURN_KEYS`' known keys is a finite number, emits it as the `turn`
 *  half of the existing `FX_USAGE_STATUS_PREFIX` sentinel (see the file
 *  header and `FxUsagePayload` in `src/shared/types.ts`) — mirroring the
 *  `usage_update` mapper branch's own malformed-tolerant handling: a
 *  non-object, `{}`, or an object with no finite-number field among those
 *  keys emits nothing rather than a chip with holes in it. Called from
 *  `runFxTurn` once `session/prompt` resolves, before the stopReason switch,
 *  so it lands on the run regardless of how the turn ended. */
function maybeEmitPromptUsage(state: FxSessionState, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const raw = usage as Record<string, unknown>;
  const turn: NonNullable<FxUsagePayload["turn"]> = {};
  let any = false;
  for (const key of FX_TURN_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      turn[key] = value;
      any = true;
    }
  }
  if (!any) return;
  const payload: FxUsagePayload = { turn };
  emit(state, "status", FX_USAGE_STATUS_PREFIX + JSON.stringify(payload), `fx:${state.runId}:${state.seq++}`);
}

async function runFxTurn(
  state: FxSessionState,
  opts: { cwd: string; promptText: string; resumeSessionId?: string; continueRecovery?: boolean },
): Promise<void> {
  // A continue-recovery turn only makes sense against a prior session — fx
  // ≥0.0.8's `_meta.fx.continueRecovery` resumes a paused checkpoint by
  // session id, it does not (and cannot) start one fresh. Fail fast, before
  // spawning any RPC traffic, rather than sending a `continueRecovery`
  // prompt against a brand-new `session/new` session fx would just reject.
  if (opts.continueRecovery && !opts.resumeSessionId) {
    failTurn(state, "fx acp: continueRecovery requires a prior session id");
    return;
  }

  // Emits the `FX_PROVIDER_STATUS_PREFIX` status chunk at most once per
  // turn, from whichever of session/new|resume|load's results carries a
  // `configOptions` provider entry first — see the file header's "Facts
  // verified against fx 0.0.5 through 0.0.8" section.
  let providerEmitted = false;
  function maybeEmitProvider(result: unknown): void {
    if (providerEmitted) return;
    const value = extractFxProviderValue(result);
    if (value) {
      emit(state, "status", FX_PROVIDER_STATUS_PREFIX + value, `fx:${state.runId}:${state.seq++}`);
      providerEmitted = true;
    }
  }

  // 1. initialize
  try {
    await withTimeout(
      sendRpc(state, "initialize", {
        // Send the NUMBER 1 — ACP's schema defines protocolVersion as a
        // number and this driver has always sent one, so nothing here
        // changes. (A prior version of this comment claimed fx rejects a
        // *stringified* protocolVersion with -32602; that was never
        // actually spike-verified — the probe scenario meant to test it
        // sent numeric 1 by mistake — so the claim is dropped. What IS
        // 0.0.8 spike-verified: an unrecognized numeric protocolVersion,
        // e.g. 999, is accepted leniently rather than rejected. Neither
        // fact changes what this driver sends.)
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agetor", version: "0" },
      }),
      RPC_HANDSHAKE_TIMEOUT_MS,
      "initialize",
    );
  } catch (err) {
    failTurn(state, describeHandshakeFailure(err, "initialize", RPC_HANDSHAKE_TIMEOUT_MS));
    return;
  }
  if (state.resolved) return;

  // 2. session/new | session/resume (+ session/load fallback)
  if (opts.resumeSessionId) {
    state.sessionId = opts.resumeSessionId;
    let resumed = false;
    // fx replays the session's prior `session/update` history (including a
    // still-`paused` recovery checkpoint, if there is one) onto THIS run
    // before the `session/resume` response itself arrives — see the file
    // header + `FxSessionState.replaying`. Flip the flag right around the
    // call, on both the success and error paths, so `dispatchSessionUpdate`
    // sees it `true` for exactly the replayed updates and nothing else; the
    // `session/load` fallback below discards its replay wholesale instead
    // (`state.suppressUpdates`) and needs no flag of its own.
    state.replaying = true;
    try {
      const resumeResult = await withTimeout(
        sendRpc(state, "session/resume", { sessionId: opts.resumeSessionId }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "session/resume",
      );
      state.replaying = false;
      maybeEmitProvider(resumeResult);
      resumed = true;
    } catch (err) {
      state.replaying = false;
      if (isTimeoutError(err)) {
        failTurn(state, describeHandshakeFailure(err, "session/resume", RPC_HANDSHAKE_TIMEOUT_MS));
        return;
      }
      // Method-not-found / invalid-params / -32600 (or any other resume
      // error) — fall back to session/load below. `-32600` is JSON-RPC's
      // generic "Invalid Request" code, not an auth-specific one — fx
      // merely reuses it for credential failures (0.0.5+, confirmed through
      // 0.0.8 — see the file header) — so it gets no special early-exit here: whether this
      // -32600 was the credential gate or fx rejecting resume as
      // unsupported, `session/load`'s own outcome (below) is what decides
      // the turn.
    }
    if (state.resolved) return;
    if (!resumed) {
      // fx replays the session's prior `session/update` history while
      // `session/load` is pending (SCHEMA-DERIVED — unexercised in the
      // spike) — the run's own persisted events already cover that
      // history, so it's discarded here rather than double-emitted.
      state.suppressUpdates = true;
      try {
        const loadResult = await withTimeout(
          sendRpc(state, "session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] }),
          RPC_HANDSHAKE_TIMEOUT_MS,
          "session/load",
        );
        maybeEmitProvider(loadResult);
      } catch (err) {
        state.suppressUpdates = false;
        if (isTimeoutError(err)) {
          failTurn(state, describeHandshakeFailure(err, "session/load", RPC_HANDSHAKE_TIMEOUT_MS));
        } else if (err instanceof RpcError && err.code === -32600) {
          // Credential re-check failed here too (0.0.5+, confirmed through
          // 0.0.8 — see the file header) — authoritative either way it reads: the same gate
          // resume just hit (load can't do better), or a non-auth "Invalid
          // Request" for which `session/load` was precisely the graceful
          // path to try. Surface fx's text verbatim, no wrapper.
          failTurn(state, err.rawMessage);
        } else {
          failTurn(state, `fx acp: failed to resume session ${opts.resumeSessionId}: ${errMessage(err)}`);
        }
        return;
      }
      state.suppressUpdates = false;
    }
    if (state.resolved) return;
  } else {
    let sessionResult:
      | { sessionId?: string; modes?: { availableModes?: Array<{ id?: string }> }; configOptions?: unknown }
      | undefined;
    try {
      sessionResult = (await withTimeout(
        sendRpc(state, "session/new", { cwd: opts.cwd, mcpServers: [] }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "session/new",
      )) as typeof sessionResult;
    } catch (err) {
      failTurn(state, describeHandshakeFailure(err, "session/new", RPC_HANDSHAKE_TIMEOUT_MS));
      return;
    }
    if (state.resolved) return;

    const sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
    if (!sessionId) {
      failTurn(state, "fx acp: session/new response had no sessionId");
      return;
    }
    state.sessionId = sessionId;
    state.onSessionId?.(sessionId);
    maybeEmitProvider(sessionResult);

    // Best-effort mode nudge — never blocks or fails the turn.
    const desiredModeId = acpModeIdFor(state.mode);
    const availableModes = sessionResult?.modes?.availableModes ?? [];
    if (desiredModeId && availableModes.some((m) => m?.id === desiredModeId)) {
      sendRpc(state, "session/set_mode", { sessionId, modeId: desiredModeId }).catch(() => { /* best-effort */ });
    }
  }

  // A NORMAL (non-continue) prompt about to run on a session whose replay
  // just carried a `paused` recovery checkpoint consumes that checkpoint —
  // fx closes the interrupted turn the moment an ordinary prompt runs (see
  // the file header). Emit the `{state:"cleared"}` sentinel BEFORE sending
  // the prompt so a stale Resume affordance can't survive past this point
  // even if this turn itself never reaches the stopReason switch below
  // (e.g. it dies mid-flight) — and reset the two fields that fed it so a
  // later replay in the SAME process (there isn't one today, but nothing
  // here relies on that) can't re-trigger this branch a second time.
  if (!opts.continueRecovery && state.replayedPaused) {
    const cleared: FxRecoveryPayload = { state: "cleared" };
    const clearedJson = JSON.stringify(cleared);
    emit(state, "status", FX_RECOVERY_STATUS_PREFIX + clearedJson, `fx:${state.runId}:${state.seq++}`);
    state.lastRecoveryJson = clearedJson;
    state.lastRecovery = undefined;
    state.replayedPaused = false;
  }

  // 3. session/prompt — the ONLY turn-completion signal; no timeout. A
  // continue-recovery turn sends fx's documented `_meta.fx.continueRecovery`
  // shape instead of a normal text prompt: an EMPTY `prompt` array (fx
  // rejects a continue call that also carries new prompt content — see the
  // -32602 handling below) plus the `continueRecovery: true` flag telling fx
  // to resume the paused response it already has a checkpoint for.
  const promptParams = opts.continueRecovery
    ? { sessionId: state.sessionId, prompt: [], _meta: { fx: { continueRecovery: true } } }
    : { sessionId: state.sessionId, prompt: [{ type: "text", text: opts.promptText }] };

  let promptResult: { stopReason?: string; usage?: unknown } | undefined;
  try {
    promptResult = (await sendRpc(state, "session/prompt", promptParams)) as typeof promptResult;
  } catch (err) {
    if (state.resolved) return; // already settled via cancel/death
    if (err instanceof RpcError && err.code === -32600) {
      // Credential re-check failed mid-prompt (0.0.5+, confirmed through
      // 0.0.8 — see the file header) — fx's text is user-actionable on its
      // own; surface it verbatim (via rawMessage, with no "(code -32600)"
      // suffix) instead of wrapping it in our own "session/prompt failed:"
      // prefix.
      failTurn(state, err.rawMessage);
    } else if (opts.continueRecovery && err instanceof RpcError && err.code === -32602) {
      // fx's own validation errors for a continue-recovery call are
      // user-actionable on their own — "No paused model response to
      // continue", "This session does not support durable recovery",
      // "Recovery continuation cannot include a new prompt" — surface
      // verbatim exactly like the -32600 credential case above, rather than
      // the generic wrapper below (which a plain "-32602 (code -32602)"
      // wrapped string would read as an internal error, not guidance).
      failTurn(state, err.rawMessage);
    } else {
      failTurn(state, `fx acp: session/prompt failed: ${errMessage(err)}`);
    }
    return;
  }
  if (state.resolved) return; // cancel/death already settled us

  // fx ≥0.0.8's `usage` object on the prompt result — the `turn` half of
  // the shared `FX_USAGE_STATUS_PREFIX` sentinel (see the file header).
  // Read BEFORE the stopReason switch so it lands on the run regardless of
  // how the turn ended (including a `refused` turn, whose `usage` is
  // typically `{}` and so emits nothing).
  maybeEmitPromptUsage(state, promptResult?.usage);

  const stopReason = promptResult?.stopReason ?? "unknown";
  switch (stopReason) {
    case "end_turn":
      settleFx(state, 0);
      return;
    case "cancelled":
      // See the comment in cancelFxTurn: the orchestrator's own
      // `handle.cancelled` flag is authoritative for cancelled-vs-failed.
      settleFx(state, 1);
      return;
    // fx's actual wire strings (`types.zig StopReason`, byte-identical
    // 0.0.7→0.0.8): `max_output_tokens`, `max_model_turns`, `refused`. The
    // ACP-canonical names (`max_tokens`, `max_turn_requests`, `refusal`)
    // this switch used to check ALONE never matched anything fx actually
    // sends — every real non-end_turn/non-cancelled stop fell through to
    // the "unexpected stopReason" default below instead (still correctly
    // `settleFx(state, 1)`, so no run was ever mis-recorded — only this
    // status line's reason text was wrong). Both vocabularies are accepted
    // here now; the ACP-canonical names are kept for forward compatibility.
    // On a `refused` turn specifically, the reason has already arrived as
    // ordinary `agent_message_chunk` assistant prose (e.g.
    // "AI_GATEWAY_API_KEY authentication failed · HTTP 401" for an
    // *invalid* key — a *missing* key instead fails `initialize` with
    // -32600 and never reaches this switch at all) — this status line is
    // supplementary, not the sole place the reason is surfaced.
    case "max_tokens":
    case "max_output_tokens":
    case "max_turn_requests":
    case "max_model_turns":
      emit(state, "status", `fx turn ended: ${stopReason}`);
      settleFx(state, 1);
      return;
    case "refusal":
    case "refused": {
      // A `refused` stop is exactly what fx reports when it exhausted its
      // Gateway retry budget and gave up (see the file header's recovery
      // -channel facts) — `state.lastRecovery` is only set from a LIVE
      // (non-replayed) recovery update this turn (see the
      // `session_info_update` case in `mapFxUpdate`), so this only enriches
      // when THIS run is the one that actually paused, never a resumed
      // follow-up merely replaying an old checkpoint. The attempt fraction
      // is omitted entirely when either number is unknown, rather than
      // printing a partial "N/undefined".
      const recovery = state.lastRecovery;
      let message = `fx turn ended: ${stopReason}`;
      if (recovery?.state === "paused") {
        const fraction =
          typeof recovery.attempt === "number" && typeof recovery.attemptLimit === "number"
            ? ` after ${recovery.attempt}/${recovery.attemptLimit} attempts`
            : "";
        message = `fx turn ended: ${stopReason} (response paused${fraction} — resumable)`;
      }
      emit(state, "status", message);
      settleFx(state, 1);
      return;
    }
    default:
      emit(state, "status", `fx turn ended with unexpected stopReason: ${stopReason}`);
      settleFx(state, 1);
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof RpcTimeoutError;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeHandshakeFailure(err: unknown, step: string, timeoutMs: number): string {
  if (isTimeoutError(err)) {
    return `${SESSION_DIED_STATUS_PREFIX}fx did not respond to ${step} within ${timeoutMs}ms`;
  }
  // A real ACP error response (e.g. the unauthenticated-binary case) is
  // user-actionable on its own — surface its message verbatim rather than
  // wrapping it, so e.g. "fx needs access to Vercel AI Gateway…" reads
  // cleanly in the run panel.
  return errMessage(err);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public surface — mirrors cursor-tmux.ts / gemini-tmux.ts's export shape so
 * the orchestrator/agents.ts wiring is mechanical.
 * ────────────────────────────────────────────────────────────────────────── */

export interface FxLaunchOptions {
  taskId: string;
  runId: string;
  /** fx argv from `buildCommand` — `[fxBin, "acp", "--model", id,
   *  "--log-file", <dataDir>/fx-logs/<runId>.log]`. This driver does not
   *  append anything to it; the prompt rides over the ACP `session/prompt`
   *  call, not argv. */
  argv: string[];
  /** Env to forward into the fx process (`FX_PERMISSION_MODE` + any harness
   *  env, e.g. a HOME override). Merged on top of `process.env` so PATH and
   *  friends still resolve. */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text, delivered via `session/prompt`'s `prompt` array. */
  promptText: string;
  /** Agetor's permission mode — drives both the `session/set_mode` nudge and
   *  this driver's `session/request_permission` auto-answer policy. */
  mode: FxMode;
  /** Set on a follow-up turn to resume (or, on failure, load) a prior ACP
   *  session instead of opening a new one via `session/new`. */
  resumeSessionId?: string;
  /** fx ≥0.0.8's `_meta.fx.continueRecovery` turn shape — continues a model
   *  response fx paused after exhausting its Gateway retry budget, instead
   *  of sending a new prompt. Requires `resumeSessionId` (fx resumes a
   *  specific session's checkpoint, it can't start one fresh); `promptText`
   *  is ignored on this kind of turn — fx rejects a continue call that also
   *  carries new prompt content (see `runFxTurn`'s `session/prompt` params
   *  and its `-32602` handling). */
  continueRecovery?: boolean;
  onChunk: ChunkHandler;
  /** Fires once with fx's `sessionId`, immediately after `session/new`
   *  resolves on the first turn (persisted as `runs.fx_session_id`). Not
   *  called again on a resumed turn — the session id is already known. */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one fx `acp` turn as a plain child process (no tmux — see the file
 * header for why) and drive it over stdio. Returns a `SpawnedAgent` whose
 * `done` resolves when the turn ends: 0 on `stopReason: "end_turn"`, 1 on
 * every other outcome — `cancelled`; fx's real wire stop reasons
 * (`max_output_tokens`, `max_model_turns`, `refused`); the ACP-canonical
 * names kept for forward compatibility (`max_tokens`, `max_turn_requests`,
 * `refusal`); a protocol error; or process death (see the stopReason switch
 * in `runFxTurn` and the file header).
 */
export function spawnFxViaAcp(opts: FxLaunchOptions): SpawnedAgent {
  ensureLogDirForArgv(opts.argv);
  const env = { ...process.env, ...opts.env };
  const [bin, ...rest] = opts.argv;
  if (!bin) {
    const done = Promise.resolve(1);
    opts.onChunk("stderr", "fx acp: empty argv — nothing to spawn", undefined);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const proc = Bun.spawn([bin, ...rest], {
    cwd: opts.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveFxProcs.add(proc);

  // Built before `state` so both `resolveDone` and `done` can be assigned
  // as plain fields on the state object at construction time (the executor
  // runs synchronously, so `resolveDone` is already the real resolver by
  // the time the object literal below evaluates it) — `waitUntilResolved`
  // needs `state.done` to race against, not just a resolver to call.
  let resolveDone: (code: number) => void = () => { /* replaced synchronously below */ };
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });

  const state: FxSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    proc,
    mode: opts.mode,
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    nextRpcId: 1,
    pending: new Map(),
    stdoutBuf: "",
    stderrRing: [],
    sessionId: opts.resumeSessionId ?? null,
    suppressUpdates: false,
    cardIdByRequestId: new Map(),
    seq: 0,
    seenLineUuids: new Set(),
    coalescer: new FxTextCoalescer(),
    resolved: false,
    killRequested: false,
    cancelRequested: false,
    resolveDone,
    done,
  };
  fxSessions.set(opts.taskId, state);

  const stdoutPump = pumpStdout(state);
  void pumpStderr(state);

  // Death watch: an unexpected process exit before we've settled the turn
  // (initialize/session/new/prompt never got their response) is a genuine
  // death, not an orderly finish — surface the shared sentinel + last stderr
  // for context. We wait for the stdout pump to drain first: `proc.exited`
  // can resolve before the pump has finished reading and dispatching
  // whatever fx already flushed to the pipe (e.g. the terminal
  // `session/prompt` response, or a protocol-error reply) — racing ahead of
  // that would clobber an actionable result/error with a generic
  // "session died" status.
  state.proc.exited.then(async (code) => {
    await stdoutPump.catch(() => { /* pump's own catch already handled/logged failure */ });
    if (state.resolved) return;
    const tail = state.stderrRing.length > 0 ? `\n${state.stderrRing.join("\n")}` : "";
    failTurn(state, `${SESSION_DIED_STATUS_PREFIX}fx process exited unexpectedly (code ${code})${tail}`);
  }).catch(() => { /* proc.exited doesn't reject in practice, but stay defensive */ });

  void runFxTurn(state, {
    cwd: opts.cwd,
    promptText: opts.promptText,
    resumeSessionId: opts.resumeSessionId,
    continueRecovery: opts.continueRecovery,
  }).catch((err) => {
    failTurn(state, `fx acp: unexpected driver error: ${errMessage(err)}`);
  });

  return {
    kill: () => { void cancelFxTurn(state); },
    // fx's ACP session has no mid-turn keystroke channel — a follow-up sent
    // while a turn is in flight folds into the orchestrator's queue and is
    // delivered as a fresh turn (new process, `--resume`-equivalent via
    // `session/resume`/`session/load`), same as cursor/gemini.
    writeInput: () => false,
    done,
  };
}

/** True when a live fx turn is registered for this task. */
export function fxSessionActive(taskId: string): boolean {
  return fxSessions.has(taskId);
}

/**
 * Tear down a task's fx session: kill the child process (if any) and dispose
 * in-memory state. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no fx
 * session exists for this task.
 */
export function dropFxSession(taskId: string): void {
  const state = fxSessions.get(taskId);
  if (!state) return;
  killProc(state);
  if (!state.resolved) settleFx(state, 1);
}

// Intentionally no `reattachFxSession` export — see the file header's
// "Architecture" section for why a mid-turn agetor restart orphans an fx run
// by design rather than reattaching to it.
