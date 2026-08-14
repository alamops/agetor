# Plan — Fix "tmux new-session failed: command too long" on continue-task with a large prompt

| Field | Value |
| --- | --- |
| Date | 2026-07-15 |
| Source | User report + screenshot (open-tmux 404, SSE flood) + prod DB forensics (task b0f273ba, 3 instant-failed runs) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/api-error-on-continue-task |
| Base SHA | 3f4b057e826383869fff20bf118f7c33b0072d0f |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (agetor-orchestrated run, owner unavailable mid-task). All assumptions logged in §8. |

## 1. Objective & success criteria

When a claude-code task's tmux session has ended and the user sends a follow-up (or starts a task) whose prompt is large (multi-KB paste), the run must start successfully instead of failing instantly with `tmux new-session failed: command too long`.

Success criteria:
- A resume (`spawnResumedSession`) with a prompt of any size spawns the tmux session and delivers the prompt.
- A fresh task-start with a huge first prompt also works (same root cause).
- Small prompts keep the exact current argv delivery path (zero behavior change for the common case).
- `bun run typecheck` green; `bun test` green.
- The `open-tmux` 404 disappears as a consequence (session actually exists after resume) — no code change needed there.

## 2. Context & constraints (grounded findings)

- Root cause chain: `orchestrator.sendClaudeTurn` (orchestrator.ts:1354) → session gone → `spawnResumedSession` (orchestrator.ts:1531) → `spawnAgent` (agents.ts:523) → `buildCommand` embeds the entire prompt as the final argv element (`args.push("--", prompt)`, agents.ts:325) → `spawnClaudeViaTmux` folds argv into one `tmux new-session … -- <argv>` (claude-tmux.ts:3339-3343) → tmux 3.6a rejects any client command ≥ ~14–16KB total (measured empirically: 14KB ok, 16KB fails with literal stderr `command too long`; tmux's 16KB imsg cap).
- The safe large-payload mechanism already exists: `pastePromptSync` (claude-tmux.ts:4412) sends the prompt over **stdin** via `tmux load-buffer -b <buf> -` then `paste-buffer -p` + gapped `Enter`, serialized through `queuePaste` (claude-tmux.ts:4602). Used by every live-session follow-up (`sendTurn`).
- Readiness signal for pasting into a *freshly spawned* session: `readPaneMode(state)` (claude-tmux.ts:3869) returns non-null only when claude's status bar shows an idle mode banner / "? for shortcuts" — i.e. the TUI is drawn and idle at the composer. Startup consent dialogs are auto-confirmed by the existing boot poller (claude-tmux.ts:3439-3528) and `readPaneMode` returns null while they're up, so a wait-for-composer loop naturally waits them out.
- On resume the JSONL already exists, so the boot JSONL-wait short-circuits and the tailer parks at EOF (claude-tmux.ts:3363) — the pasted prompt's turn is then journaled and resolves the run normally.
- The failing task's agent kind is an aliased claude-family custom harness (kind `claude-code`, custom id) — the fix must live on the shared claude-code spawn path, not be keyed to the literal `"claude-code"` string without checking how claude-family kinds dispatch in `spawnAgent`/`buildCommand`.
- `agents.test.ts:110-131, 238-279` currently asserts the prompt is always the final argv element (including with `resumeSessionId`) — those assertions stay valid for small prompts; new cases cover the deferred path.
- Test conventions: `claude-turn-routing.test.ts` uses a fake `AGETOR_TMUX_BIN` script that logs every argv invocation to a JSONL file — ideal for asserting "new-session argv never contains the big prompt; load-buffer carries it". `claude-followup-restart.test.ts` covers the resume dispatch path with `AGETOR_CLAUDE_BIN=/bin/echo` + real tmux.

## 3. Approach & key decisions

**Threshold-deferred paste.** In the claude spawn path, when the prompt is large, omit it from argv and deliver it after launch via the existing `queuePaste` machinery, gated on composer readiness.

- `CLAUDE_PROMPT_ARGV_MAX_BYTES = 4096` (constant in agents.ts, comment citing the measured ~14–16KB tmux client-command cap and headroom for `-e` env pairs + flags).
- `buildCommand` claude branch gains an option (or `spawnAgent` decides) to skip `args.push("--", prompt)`; the raw prompt is passed to `spawnClaudeViaTmux` as `deferredPrompt`.
- `spawnClaudeViaTmux`: after a successful `new-session` + state allocation, when `deferredPrompt` is set, fire an async loop: poll `readPaneMode(state)` every ~400ms up to 30s (abort if session dies); on ready — or best-effort on timeout with a status note — `void queuePaste(taskId, sessionName, deferredPrompt, 0, state, { bracketed: true })`. Emit a `status` chunk so the user sees the prompt is being delivered.

Alternatives considered:
- *Always paste, never argv*: one code path, but regresses the battle-tested happy path for every task start and races startup consent dialogs on every fresh boot. Rejected — the deferred path should stay the rare exception.
- *Codex-style stdin/prompt-file*: not applicable — claude's interactive TUI has no prompt-from-file flag and owns its stdin.
- *Truncate the prompt*: unacceptable data loss.

## 4. Work breakdown — implementation tasks

- **T1 (wave 1)** — Core fix. Owns `src/bun/agents.ts` + `src/bun/claude-tmux.ts` (coupled; single agent). Threshold + defer plumbing + composer-wait paste. Acceptance: typecheck green; a >4KB prompt never appears in the `tmux new-session` argv; small prompts unchanged.

## 5. Work breakdown — test tasks

- **T2 (wave 2)** — Owns `src/bun/agents.test.ts`. Cases: small prompt → argv unchanged (existing assertions still pass); >4KB prompt → argv contains no prompt element (with and without `resumeSessionId`); boundary at exactly 4096 bytes.
- **T3 (wave 2)** — Owns `src/bun/claude-turn-routing.test.ts` (and `claude-followup-restart.test.ts` if a resume-shaped case fits better there). Using the fake-tmux argv logger: large-prompt resume → `new-session` argv excludes the prompt AND a `load-buffer`/`paste-buffer` sequence delivers it; assert no `command too long`-style failure path.

## 6. Execution waves

- Wave 1: T1 alone (both files coupled).
- Barrier: typecheck + commit.
- Wave 2: T2 ∥ T3 (disjoint files).
- Then: review (opus) → run tests (haiku) → fixes if needed.

## 7. Blast radius & risks

- Every claude-family task start and resume flows through `spawnAgent`/`spawnClaudeViaTmux`. Mitigated by the threshold: <4KB prompts (vast majority) take the byte-identical current path.
- Paste-at-boot timing: mitigated by the `readPaneMode` readiness gate + existing bracketed-paste gap logic in `queuePaste` (commit 9457e1f). Consent dialogs are handled by the existing boot poller before the composer can appear.
- On resume, the boot error path (`jsonl-discovery-timeout`) never fires (JSONL exists), so the deferred-paste loop carries its own timeout with best-effort paste + status note rather than hanging silently.
- `AGETOR_CLAUDE_DRIVER=fake` short-circuits before tmux — orchestrator-level tests unaffected.

## 8. Open questions / assumptions (autonomous mode)

1. **Scope includes the fresh-start path** (same root cause, same fix site) — assumed yes.
2. **Threshold 4096 bytes on the prompt** — conservative vs the measured ~14–16KB whole-command cap; env-only overflow (pathological giant env) is pre-existing and out of scope.
3. **The SSE "network connection was lost" flood in the screenshot** is the app/server being down or restarting at capture time, not part of this defect — out of scope.
4. **`open-tmux` 404** is a downstream symptom (no session exists because spawn failed); no route change.
5. Medium prompts (4–14KB) that technically worked via argv now go via paste — accepted behavior change, paste is the battle-tested follow-up mechanism.
