# Harness: gemini

> Moved from `CLAUDE.md`, where this was the `gemini` bullet of “Agent command shape”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

**`gemini`** → driven through `src/bun/gemini-tmux.ts`, architecturally a near-clone of codex's driver (one-shot per turn, hosted in a detached per-task tmux session for restart survival) — but with two real differences from codex, both verified empirically against a live spike (CLI 0.54.0, real API calls), not inferred from docs.
Launch argv: `gemini -m <model> --output-format stream-json [--session-id <uuid> | --resume <uuid>] [--yolo | --approval-mode plan] --skip-trust -p <prompt>`.

**(1) Session id is self-issued, not discovered**: agetor mints the uuid itself (mirrors claude's pre-generated-uuid pattern) and passes it via `--session-id` on the first turn / `--resume` on every follow-up — confirmed `--resume <uuid> -p "..."` correctly recalls context established under `--session-id <uuid>` on a prior turn.
No `onSessionId` round-trip is needed the way codex needs one for its `thread_id`.

**(2) Prompt rides in argv (`-p <prompt>`), not stdin** — codex avoids the tmux `new-session` ~16KB client-command cap entirely by piping its prompt via a file redirect; gemini has no confirmed stdin-only delivery path (its `--help` hints `-p`'s value is "Appended to input on stdin (if any)", but this was unverified — the live API was returning 503s during the spike that would have confirmed it), so `buildCommand` throws above `GEMINI_PROMPT_ARGV_MAX_BYTES` (4096, same budget as claude's) instead of guessing — there's no deferred-paste fallback for a one-shot process the way claude's persistent REPL has.
Structured output comes from tailing gemini's `stream-json` NDJSON log (`dataDir/gemini-logs/<runId>.jsonl`, confirmed flushed incrementally, not buffered to process exit); the mapper (`mapGeminiEvent`) turns `init`/`message`/`tool_use`/`tool_result`/`result` events into the same `assistant`/`tool_use`/`tool_result` streams the other two agents emit — **gemini has no `thinking` stream**: reasoning traces exist (verified in the on-disk checkpoint transcript at `~/.gemini/tmp/<dir>/chats/session-*.jsonl`) but never appear in `stream-json` stdout, a real parity gap versus claude/codex, not an oversight.
`result.status !== "success"` resolves the turn failed; a `result` event is gemini's only terminal signal (no separate completed/failed event types the way codex has).

**`--skip-trust` is mandatory** regardless of mode — gemini's headless mode refuses to run tool calls in an untrusted directory (exit 55) even under `--yolo`, and every agetor task runs in a fresh worktree path that's inherently untrusted on first run.

**No sandbox flag** — gemini's `--sandbox` is a heavyweight opt-in (backed by Docker on this machine; pulling the image alone took 30s+ with no output) unsuitable for agetor's default `auto` mode, and unlike codex there's nothing to escalate: default (no `-s`) already gives unrestricted filesystem access, confirmed by a real `write_file` tool call succeeding with no sandbox flag — so `gitWritableRoots`'s external-git escalation logic has no gemini analog.

**Never pass gemini's own `-w/--worktree` flag** — agetor already manages worktrees; it would create a second, agetor-unaware worktree nested inside agetor's.
Config-dir override uses `GEMINI_CLI_HOME` (verified in the bundled CLI source: `homedir()` returns `process.env.GEMINI_CLI_HOME || os.homedir()`), a dedicated env var — unlike codex there's no need to also touch the real `HOME`.
