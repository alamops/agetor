# Grill — Claude Code composer placeholder read as an unknown prompt

| Field | Value |
| --- | --- |
| Date | 2026-10-12 |
| Source | `docs/plans/claude-code-placeholder-investigation.md` (pipeline step 1), owner screenshots 1 and 2, code at `a46aa6c` |
| Mode | interactive, answered by the owner (two passes via AskUserQuestion, every question answered) |
| Flags | none |
| Branch | `fix/claude-code-placeholder` |

## Grounding added in this step (beyond the investigation brief)

- **The summary line carries two flags, not one.** Prod JSONL (`~/.claude/projects/-Users-<user>--agetor-worktrees-00000000-…/11111111-….jsonl`, read for keys only) line 959 is `type:"user"` with `isCompactSummary: true` **and** `isVisibleInTranscriptOnly: true`, 16,448 chars of content. (The brief's line numbers are off by one: `compact_boundary` is 958, the summary 959, `system`/`informational` "Compacted while idle, before the prompt cache expired" 972.) The brief's assumption that `isVisibleInTranscriptOnly` "did not appear" is wrong: it is on the summary line itself.
- **`compact_boundary` and `informational` are silently dropped today.** `mapParsedEventToChunks` `case "system"` (`src/bun/claude-tmux.ts:1370-1409`) has branches only for `permissionMode`, `local_command` and `turn_duration`; the `case "summary"` branch (`:1411`) handles a different, older line type. So the only trace of a compaction in agetor today is the 16 KB YOU bubble. `compactMetadata` carries `trigger` (`"auto"`), `preTokens` (450162), `postTokens` (8613) and `durationMs` (120316).
- **A placeholder alone never cards an idle task.** Both arms of `matchUnparsableModal` need either a modal footer or `stuckTurnFallbackArmed`, which requires `turnInFlight`. The card needed the phantom continuation (cause A) *and* the non-bare-row reading (cause B) together.
- **The 10-minute stall breadcrumb becomes moot once B is fixed.** `idleSettleEligible` (`:6629-6639`) = `paneIdle` + 60 s since agetor's last keystroke + no pending prompt + the watchdog conditions; with a placeholder row counting as idle, such a turn settles at ~66 s (60 s + 3 ticks at 2 s), long before `checkTurnStall`'s 10 min.
- **Escape-Escape exposure is narrow but real.** `queuePaste` only runs the composer clear when `composerHoldsText` is set (`:10345`, after a pre-enter withhold). If a placeholder re-renders on that row afterwards, today's `paneShowsComposerText` reads it as text and sends `Escape Escape` into an EMPTY composer, which opens Claude's rewind picker; the post-clear verify (`:10396`) then fails, so the paste is withheld (`composer-dirty`). The placeholder fix removes this.
- **Agetor's non-invasive stance** (`src/bun/hook-installer.ts:9-30`, `claude-tmux.ts:7392`): no hooks, no MCP server, no CLAUDE.md addendum; `settings.local.json` is only cleaned. A launch env var has precedent (`CLAUDE_CODE_EFFORT_LEVEL`), so the owner's "suggestions off" choice fits it: no file is written.
- **The run-status text is the same for every trigger**: `startContinuationRun(taskId)` (`src/bun/orchestrator.ts:5587-5635`) emits `auto-continued after background task` unconditionally (`:5626`); the factory gets no trigger argument today.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Scope | Fix the compaction trigger (A), the placeholder reading (B), or both? | **Both.** Either fix alone leaves a visible defect: B alone still opens a phantom run after every idle compaction (settled ~66 s later, card bouncing `review → running → review`, possibly a notification); A alone leaves every other turn that never sends `end_turn` stuck behind a placeholder. | owner (D-defaults, accepted) + evidence above |
| 2 | Placeholder strategy | Detect placeholders, switch prompt suggestions off, or both? | **Detect + suggestions off.** Read the composer row's styling and treat all-dim text as an empty composer, **and** launch every agetor claude session with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. No Settings toggle (the owner did not pick the toggle option). | owner |
| 3 | Idle rule | Does a placeholder-only row count as fully idle, or only suppress the card? | **Fully idle.** `paneShowsIdleInputBox` is true and `paneShowsComposerText` is false for a placeholder row, so the idle-settle net can close a turn that never sent `end_turn`, and the paste/clear paths treat the box as empty. | owner |
| 4 | Compaction rendering | How does a compaction summary render? | **A status line plus a collapsed block.** The status line reads `context compacted while idle · 450k → 8.6k tokens`, dropping "while idle" for other compactions. The block is a collapsed "Compaction summary" you can expand to read the text. Applies to **every** compaction (idle, auto mid-turn, manual `/compact`), not just idle ones. | owner |
| 5 | Retroactivity | Do stored transcripts re-render? | **New events only.** Summaries ingested after the fix render the new way; stored rows (e.g. `run_events` 865529) keep today's YOU bubble. Consequence for the plan: recognition must ride on Claude's own JSONL flag at **ingest** (server-side), **not** on client-side detection of the summary's opening sentence. How the event carries the marker (a recognised tag, a distinct stream, …) is the planner's call. Constraints: persisted text stays Claude's own text, it must never reach a harness, and the change must not alter `canonicalizeUserText`/dedup for real user messages. | owner |
| 6 | Adoption wording | Reword `auto-continued after background task` per trigger? | **Yes, in this change.** task-notification → `auto-continued after background task` (unchanged); a `user` line typed in the attached terminal → `turn started from the terminal`; Claude writing with no turn open (assistant-line trigger) → `Claude continued on its own`. `startContinuationRun` gains a trigger argument from `maybeAdoptContinuation`. | owner |
| 7 | Idle compaction | Keep Claude's idle compaction on for agetor sessions? | **Leave on.** Once A is fixed it's harmless, and it saves re-reading a large uncached context after a long break. No `--settings` override. | owner |
| 8 | Acceptance | What proves it's done? | **Unit + e2e + a live smoke.** Unit: styled-pane fixtures, the adoption filter, the suggestion env var in the launch command. Playwright e2e: compaction-summary rendering (status line + collapsed block) through a fake-driver seam, since the prompt-echo seam can't carry the ingest-side flag (decision 5). Manual live smoke on `~/.agetor-dev`: one haiku turn shows no suggestion (env var works), the startup `Try "…"` placeholder reads as idle, and no card appears. | owner |
| 9 | Suggestion in RunPanel | Show Claude's suggestion as a one-click send? | **Moot → out of scope.** Suggestions are off in agetor sessions (decision 2), so there's nothing to show. | consequence of owner decision 2 |
| 10 | Stall breadcrumb (brief Q6) | Suppress the 10-minute "turn stalled … dialog may be open" message on an idle composer? | **No change.** Once decision 3 lands, idle-settle closes an idle-composer turn at ~66 s, so the stall message can no longer fire on one. | evidence (`:6629-6639`, `:1866-1900`) |
| D1 | Adoption filter | What does the filter key on? | Skip a `user` line with `isCompactSummary === true` **or** `isVisibleInTranscriptOnly === true` (the prod line carries both). Turns typed in the attached terminal still adopt (run `aaaa0003` is the legitimate case). Same deny-known-synthetic, allow-by-default stance as the `task-notification`/`isMeta` handling. | owner (accepted default) |
| D2 | Suggestions-off reach | Where does the env var go? | `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on **every** claude-code-kind launch: the built-in harness and extra-account harnesses, fresh and `--resume` (`spawnResumedSession`). It overrides the user's own `promptSuggestionEnabled` inside agetor sessions (env wins, per the binary). Sessions already alive at upgrade (reattached) keep suggestions until they respawn; detection covers them. | owner (accepted default) |
| D3 | Placeholder definition | What counts as a placeholder row? | Text after `❯ ` that is **entirely SGR-dim**, where the first character may be inverted by the cursor. Both observed shapes count: one contiguous dim span (suggestion) and per-word dim spans with resets at spaces (startup sample). A row matching `UNSUBMITTED_PASTE_RE` (`[Pasted text …]`) or holding an `[Image #N]` chip is **never** a placeholder; the planner spikes their styling. One rule for all three placeholder kinds (suggestion, `Try "…"`, `Message @<agent>…`). | owner (accepted default) |
| D4 | Capture mechanics | How is styling read? | A **second** `tmux capture-pane -e` read, taken only when the plain live `❯` row is non-bare. Every matcher, the stability fingerprint and the `__external__` sweep keep reading plain text, so #191's de-flicker is untouched. | owner (accepted default) |
| D5 | Caller reach | Which callers get the placeholder-aware predicates? | All of them: the scraper's watchdog veto and idle-settle (`scrapeOnce`), `queuePaste`'s composer clear (pre-clear text check, post-clear verify, already-bare branch), `dismissAskModalForMessage`, `autoConfirmSlashModal`. A placeholder must never trigger `Escape Escape`. | owner (accepted default) |
| D6 | Backstop | Add a watchdog for content-triggered adoptions? | No. The placeholder-aware idle-settle net (~66 s) is the backstop. | owner (accepted default) |
| D7 | Compaction breadcrumb source and side surfaces | Where does the status line come from, and what else changes? | Built from Claude's `system`/`compact_boundary` (`compactMetadata.preTokens/postTokens/trigger`) and `system`/`informational` "Compacted while idle…" lines, both silently dropped today. The summary is left out of the message-history resend list (`MessageHistoryPicker`/`cleanMessageText`) and does not count as a user message for the first-load anchor (`runs.lastUserEventId`). A non-adopted summary routes to `state.lastChunk` (the previous run), like the local-command twins; it moves no column and doesn't mark the task unread. | owner (accepted default) |
| D8 | CLI/TUI | How do `agetor logs` and the TUI show it? | The status line plus one `summary›` line (the summary's first line and its size), not the full 16 KB. | owner (accepted default) |
| D9 | Fixtures | Real or synthetic? | Synthetic only: no content, titles, paths or ids from the owner's real session, per the no-real-data rule. Add a fixture for the new `⧉ index` status-bar variant. | owner (accepted default) |
| D10 | Data/docs | Schema, backfill, docs? | No schema change, no backfill; stored phantom runs stay as history. Update CLAUDE.md's claude-code bullet (idle-box / idle-settle / unparsable-card text, continuation adoption) and the related plan docs (`unknown-claude-prompts-fallback.md`, `model-effort-local-command-turns.md` §10, `adopt-continuation-on-task-notification.md`). | owner (accepted default) |
| D11 | Rollout | Flag? Unrelated errors? | No feature flag; ships in the next release as a bug fix. The `SessionStart:compact hook error … node: command not found` lines are out of scope: the PATH fix #258 (`a46aa6c`) is already on main. | owner (accepted default) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Exclude compaction-summary lines from continuation adoption (`isContinuationContentEvent`) + pin it in `claude-continuation.test.ts` | in this change | owner (decision 1, D1) |
| Placeholder-aware `livePromptRow` / `paneShowsIdleInputBox` / `paneShowsComposerText` with styled second capture | in this change | owner (decisions 2–3, D3–D5) |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on every claude-code launch path | in this change | owner (decision 2, D2) |
| Compaction status line from `compact_boundary` / `informational` | in this change | owner (decision 4, D7) |
| Collapsed "Compaction summary" block in RunPanel, for every compaction kind | in this change | owner (decision 4) |
| Ingest-side marker for the summary event (server) + client rendering of that marker | in this change | owner (decision 5) |
| Summary excluded from the history resend picker and the first-load anchor | in this change | owner (D7) |
| CLI `agetor logs` / TUI `summary›` line | in this change | owner (D8) |
| Per-trigger adoption wording (`startContinuationRun` trigger argument) | in this change | owner (decision 6) |
| Unit fixtures: both dim shapes, cursor-inverted first char, typed-text negative, `[Pasted text …]` negative, `⧉ index` bar; env var in the built command; adoption of a two-flag summary line (negative) and a terminal-typed line (positive) | in this change | owner (decision 8, D9) |
| Playwright e2e for summary rendering through a fake-driver seam | in this change | owner (decision 8) |
| Manual live smoke on `~/.agetor-dev` | in this change | owner (decision 8) |
| Docs updates (CLAUDE.md + plan docs) | in this change | owner (D10) |
| Re-rendering already-stored summaries (client-side opening-sentence match) | out of scope | owner chose new events only (decision 5) |
| "Claude suggests: …" one-click send in RunPanel | out of scope | moot: suggestions disabled in agetor sessions (decision 2) |
| Settings toggle for prompt suggestions | out of scope | owner chose always-off, not the toggle option (decision 2) |
| Turning off idle compaction (`--settings idleCompaction:false`) | out of scope | owner chose to leave it on (decision 7) |
| Suppressing the 10-minute stall breadcrumb on an idle composer | out of scope | moot after decision 3 (decision 10) |
| New watchdog for content-triggered adoption | out of scope | idle-settle is the backstop (D6) |
| `SessionStart` hook `node: command not found` | out of scope | already fixed by #258 on main (D11) |
| Backfill / rewrite of stored phantom continuation runs | out of scope | history; no schema change (D10) |

## Assumptions still open

- **The suggestion env var is honoured by every claude version agetor supports.** The binary for 2.1.296 reads `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` before `promptSuggestionEnabled`. Older CLIs that ignore it still show suggestions, and dim-text detection (decision 2) covers them. If wrong: no regression, just suggestions still visible.
- **Placeholder text is always rendered dim through Claude's single placeholder renderer** (proven for the suggestion and the startup sample on 2.1.296). If a future CLI draws one in normal colour, detection falls back to today's behaviour (the card), never to something worse.
- **`[Pasted text …]` / `[Image #N]` composer chips are not all-dim**, or are excluded explicitly (D3). The planner spikes their SGR styling. If one were all-dim and not excluded, a turn holding an unsent paste could be idle-settled and pasted over. D3's explicit exclusion is what guards this.
- **Idle compaction can't be reproduced live in a smoke.** It needs ~54 min idle and ≥100k tokens. The adoption fix and the rendering are covered by a synthetic fixture shaped like prod line 959 (both flags) plus the `compact_boundary`/`informational` lines; the live smoke covers only placeholders and the env var.
- **`compact_boundary` and `informational` ordering.** In prod the summary line was written *after* `compact_boundary` in the file but carries an earlier timestamp (`.382` vs `.385`), and `informational` came ~280 ms later. The status line must not assume an order; joining "while idle" onto the boundary line may need to tolerate the informational notice arriving after it, or show it as its own line. That's the planner's call; the owner's wording only needs to stay legible.
- **Enter on an empty composer showing a suggestion is a no-op** (changelog 2.1.136). It's no longer exercised in agetor sessions with suggestions off; it only matters for sessions reattached at upgrade. Not live-verified; low exposure (agetor only sends Enter after a parsed modal or a landed paste).
