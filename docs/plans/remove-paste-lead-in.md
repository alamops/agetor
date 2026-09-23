# Plan — Retire the "My own message, sent from Agetor:" paste lead-in

| Field | Value |
| --- | --- |
| Date | 2026-09-21 |
| Source | Owner task: "Do not send `My own message sent from Agetor` to Claude Code. Don't include `Agetor` message prefix or suffix mention to any harnesses" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | Grill answered by owner ("Keep stripping"); plan approval asked once (agetor-launched run) |
| Branch | fix/remove-agetor-mention-to-harnesses |
| Base SHA | 6bbe2f8 |

## 1. Objective & success criteria

Agetor must never type or prepend an Agetor-branded line to anything it delivers to a harness.

Done means:

- A claude-code bracketed paste is exactly `load-buffer → paste-buffer -p → delete-buffer → gap → Enter` again — no `send-keys -l <lead-in>` and no `send-keys C-j` before it. Verified by the recorded-tmux queue tests.
- `pasteLeadInFor`, `pasteLeadInDisabled`, the `AGETOR_CLAUDE_PASTE_LEAD_IN` env kill switch and the `__forTest.setPasteLeadInEnabled` seam are gone — there is nothing to switch off.
- Already-persisted transcripts that carry the old line still render clean: `normalizeDeliveredUserText` keeps stripping every spelling in `AGETOR_PASTE_LEAD_INS` (owner decision, grill Q1). The constant is documented as retired / legacy-only.
- No other prompt builder carries an Agetor prefix or suffix (audited, see §2).
- `bun run typecheck` and the affected `bun test` files are green; CLAUDE.md item 17 and the pasted-content plan reflect the retirement.

## 2. Context & constraints

- The only Agetor-branded text delivered to a harness is the paste lead-in, typed in `queuePaste`'s bracketed branch (`src/bun/claude-tmux.ts:9926-9985`) via `pasteLeadInFor` (`:9420`) and gated by `pasteLeadInDisabled` (`:9383`) plus the test override `pasteLeadInOverride` (`:9374`, exposed as `__forTest.setPasteLeadInEnabled` at `:8944`).
- The lead-in string lives in `src/shared/user-message.ts:898` (`AGETOR_PASTE_LEAD_IN`) with the append-only `AGETOR_PASTE_LEAD_INS` (`:909`) that `stripPasteLeadIn` (`:966`) consumes inside `normalizeDeliveredUserText`. Persisted `run_events` are raw, so historical sends still carry the line — the strip is what hides them.
- Audit of other harness-bound text (no Agetor mention found): `appendReferences` heading `Referenced files/folders:` (`src/shared/refs.ts:9`), `composeLaunchPrompt`'s `<agent_instructions_defined_by_the_user>` wrapper (`src/shared/agent-profile.ts`), `ISSUE_UNTRUSTED_CONTENT_WARNING` (`src/shared/issue-task.ts:21`), the cursor plan-approval message (`src/bun/server.ts:5380`), the ELI5 prompt (`src/shared/clone-eli5.ts`). Codex/cursor/gemini/fx deliver prompts via stdin/argv/RPC and never went through the lead-in path.
- Why the lead-in existed: Claude Code 2.1.277 wraps bracketed pastes in `<pasted_content>` and tells the model that text is lower-trust (docs/plans/pasted-content-tags.md). The owner is now choosing to drop the lead-in anyway; the display-side unwrap of `<pasted_content>` stays, so the rendering fix from that plan is unaffected.
- Tests touching the lead-in: `src/bun/claude-tmux-queue.test.ts` (lead-in assertions at ~`:1005`, `setPasteLeadInEnabled` at `:1041/:1089`, `pasteLeadInFor` unit tests `:1101-1148`, env-kill-switch queue test `:1201-1220`), `src/bun/claude-turn-routing.test.ts:564` (finds the lead-in send-keys index), `src/bun/claude-tmux-local-command.test.ts:36-38` (pins lead-in off). Shared/webview tests (`user-message.test.ts`, `event-dedup.test.ts`, `message-history.test.ts`, `event-search.test.ts`, `e2e/pasted-content.spec.ts`) exercise the legacy strip and stay valid.

## 3. Approach & key decisions

- **Delete the delivery side outright** (no flag flipped to default-off): the owner's ask is "do not send", and a dormant code path plus env switch is the kind of thing that gets re-enabled by accident.
- **Keep the strip side, mark it legacy** (owner, grill Q1): `AGETOR_PASTE_LEAD_IN` stays exported (six test files and the e2e spec import it) but its doc comment now says it is no longer typed and exists only so historical raw events render clean. `AGETOR_PASTE_LEAD_INS` stays append-only for the same reason.
- **`composerHoldsText` bookkeeping** in the bracketed branch simplifies: with no lead-in, a `pastePrompt` failure no longer strands text before the paste, so the `leadIn !== null` flip goes away; the pre-paste modal guard's second `stillBlocking` re-gate (added only because the lead-in's two round-trips opened a window) goes away too.
- **Docs**: CLAUDE.md item 17 is rewritten to describe the retired state; `docs/plans/pasted-content-tags.md` gets a short "Status" addendum at the top pointing here rather than a rewrite of its history.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns | Depends on |
| --- | --- | --- | --- |
| T1 | Remove the lead-in typing, `pasteLeadInFor`, `pasteLeadInDisabled`, `pasteLeadInOverride`, `__forTest.setPasteLeadInEnabled`, and every comment that describes the lead-in in the driver | `src/bun/claude-tmux.ts` | — |
| T2 | Re-document `AGETOR_PASTE_LEAD_IN` / `AGETOR_PASTE_LEAD_INS` / `normalizeDeliveredUserText` as legacy-strip-only | `src/shared/user-message.ts` | — |
| T3 | Update the three bun test files: drop lead-in assertions and `setPasteLeadInEnabled` calls, replace the removed unit tests with a pin that a bracketed paste's first tmux call is `load-buffer` | `src/bun/claude-tmux-queue.test.ts`, `src/bun/claude-turn-routing.test.ts`, `src/bun/claude-tmux-local-command.test.ts` | — |
| T4 | Docs: CLAUDE.md item 17, status addendum on `docs/plans/pasted-content-tags.md` | `CLAUDE.md`, `docs/plans/pasted-content-tags.md` | — |

## 5. Work breakdown — test tasks

- T3 already carries the regression pin (a bracketed paste emits no `send-keys -l` and starts with `load-buffer`). No new test file is needed.
- e2e: not applicable — the change removes two tmux keystrokes; the Playwright fake driver never typed them, and `e2e/pasted-content.spec.ts` (legacy display) stays green unchanged.

## 6. Execution waves

- Wave 1: T1, T2, T3, T4 in parallel (disjoint files). T3 is written against the post-T1 API by contract (no `pasteLeadInFor` export).
- Barrier: typecheck + `bun test` on the four bun test files + the shared/webview lead-in tests.

## 7. Blast radius & risks

- Trust gap re-opens for pasted claude-code messages on CLI versions that wrap pastes (`tengu_virtual_pancake`). Owner-accepted.
- No DB, API or webview change. CLI/TUI unchanged (they consume the shared normalizer).
- Rollback: revert the commit.

## 8. Open questions / assumptions

- A1: the `.claude/CLAUDE.md` committed in this repo (which mentions the `agetor` MCP server) is project instructions, not a message prefix/suffix, so it is out of scope for "message prefix or suffix".

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Lead-in typing + gate + env switch + test seam | in this run — T1 |
| Legacy strip constant docs | in this run — T2 |
| Tests referencing the removed API | in this run — T3 |
| CLAUDE.md item 17 + plan doc status | in this run — T4 |
| Other Agetor-branded prompt text | out of scope — audit found none |
| Fleet knowledge decision entry (lead-in rationale) | in this run — superseded by a new decision entry after landing |
