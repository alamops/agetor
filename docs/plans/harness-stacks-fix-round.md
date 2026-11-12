# Plan — Harness stacks fix round + improvements

| Field | Value |
| --- | --- |
| Date | 2026-11-09 |
| Source | Post-merge review of PR #295 (this session; the findings are restated in §4's finding map) + owner chat decisions + grill rounds 1–3 |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku) |
| Flags | none |
| Gates | grilled via decision form (`docs/plans/harness-stacks-fix-round-grill/round-1..3/answers.json`, all complete; every question answered by the owner) + plan approved by owner (chat, 2026-11-09) |
| Status | done on the branch and pushed, through review round 4. First round (the plan's findings, the wave reviews and the Phase 5 review): every ledger row swept in (§9). Final run at `210e8c20`: typecheck clean; `bun test` 12,696 pass / 0 fail / 30 env-gated skips (492 files); Playwright 459 passed / 1 failed, a stale assertion in `agent-profiles-launch.spec.ts`, since fixed (10/10). Review round 2 (code review at `7f6383bd`, see the ledger section of that name): 29 of the 30 findings fixed in code, tests or docs, and N10 handled in the PR body instead of the code; of the five re-review items, RR-1–RR-3 fixed, RR-4 kept by decision and RR-5 accepted. Final run of that round on the committed tree: typecheck clean; `bun test` 12,782 pass / 3 fail / 30 env-gated skips (495 files). The 3 failures are `claude-tmux-askdrive.test.ts` fake-tmux timeouts; that file fails the same way on `main` (`c45fd806`) — 10 failures there in a standalone run on 2026-11-10. Playwright e2e at `e7f106e2`: 448 passed / 3 failed / 12 not run (serial siblings of the failures); the 3 (`issue-task.spec.ts:622`, `opencode-server.spec.ts:359`, `pr-merged-state.spec.ts:255`, timing under parallel load, none in harness-stack code) passed alone, and their three spec files passed in full (23/23). Review round 3 (code review at `b7bbfce5`, see the ledger section of that name): all 22 findings fixed, 19 in code with a regression test and S9, S10 and N10 in the docs; M2 and the S2 drop follow owner decisions Q1 and Q2; the account re-point confirmation (sibling of S2) is fixed too, with one accepted narrow window recorded in that section. Final run of this round, on the committed tree: typecheck clean; the 14 test files the round changed (544 tests) and 59 related files (holds, Stop, archive, switches, pipelines, reconcile, routes; 1,786 tests) pass with each file run alone, 0 failures. A full `bun test` did not finish on 2026-11-11: under load 12 to 187 (a VM, XProtect scanning freshly written scripts) the fake-tmux files timed out at 5 s (`claude-turn-routing`, `claude-tmux-local-command`, `opencode-tmux`, `codex-limit`, `claude-tmux-askdrive`) and the run hung; run alone at `b7bbfce5` the same four files checked fail the same way, as often or more (for example `claude-turn-routing` 7 failures there, 3 here), and `codex-limit` and `opencode-tmux` are untouched by the branch. Playwright e2e at `f1a9eec7` (load 16 at the start, back above 90 during the run): 416 passed / 15 failed / 32 not run (serial siblings), none in a harness-stack spec. The 17 spec files with a failure were rerun in full: 13 passed (183 tests); the other 4 failed only on infrastructure (the browser closed, a worker found the previous worker's backend still on port 4600, a 401 from that leftover backend) and passed in full with one worker (`agent-profiles-dialogs`, `identifier-inputs`, `pasted-content`, `pipelines-editor`; 28/28). Before merging, the migrations 087–090 were applied to a `VACUUM INTO` snapshot of the owner's production database (at 086): 20 ms, `quick_check` ok, foreign keys clean, a rerun a no-op, tasks and runs unchanged; on a second snapshot seeded with 086-shaped stack and cooldown rows, the cooldowns carried over as whole-account rows and the branch's stores read and wrote them; both copies deleted. Review round 4 (independent re-review of `f1a9eec7`, see the ledger section of that name): 4 should-fix and 6 nits, all fixed, one accepted narrow window recorded in R4-4. Final run of that round: typecheck clean; the 26 affected test files pass with each file run alone (790 tests, 0 failures); the harness-stack, auto-enable, run-panel-header and switch-during-restore e2e specs: 21 passed / 2 failed / 10 not run under a load spike to 81, then the two spec files with a failure passed in full with one worker (14/14), neither touched by this round. |
| Branch | `fix/harness-stacks-fix-round` |
| Base SHA | `c45fd80699c931472f584c347695de0f521fa1cd` |

Binding references: `docs/architecture/harness-stacks.md` (current contract, updated by this change), `CLAUDE.md` (repo rules), `docs/architecture/security.md`, `docs/architecture/persistence.md`.

## 1. Objective & success criteria

Close every gap the post-merge review found in harness account stacks, and add five owner-requested capabilities: mirror provenance (with backup + restore), a per-stack swap history, per-member quota in Settings, a "switch to next account" action, and Stacks merged into the Harnesses settings page.

Each criterion names its production path and the test that drives it:

- **SC1 — No stuck cards.** A successor that hits a limit while a swap/boot claim is held is settled (moved, blocked or failed normally), never left `running` with nothing live. Path: run done handler → `handleHarnessLimitSettlement`. Test: orchestrator unit (limit during `deliverHeldFollowUpsToSuccessor`; limit during the boot swap claim).
- **SC2 — Crash mid-swap resumes.** A core killed during mirror/transfer resumes the swap at boot (`resumeInterruptedSwap`), with the pipeline step unsettled. Path: `index.ts`/`headless.ts` boot → `reconcileOrphans` → `reconcilePendingHarnessSwaps`. Test: orchestrator unit leaving the old run `running` before `reconcileOrphans()`.
- **SC3 — No lost or reordered follow-ups.** Codex queued follow-ups and unread Claude follow-ups reach either the successor or the backlog tray on every ending (blocked, aborted, Stop, failed spawn, cancelled countdown, manual message, cap). Test: orchestrator unit per ending.
- **SC4 — Cooldowns are accurate.** A success that started before the limit doesn't clear it; a Codex per-model limit cools only that model; an expired tried member is retried within ~10 s; a just-passed time-only reset doesn't add 24 h; quota snapshots detect a 5 h window at 100%. Test: shared/harness-limits, shared/harness-stack, harness-stacks store, orchestrator settle.
- **SC5 — Selection is correct.** Default-model tasks get catalog/CLI-floor checks; cloud env keys without a selector are not login evidence; 1-member stacks are inert on Run/message. Test: harness-failover, harness-stacks unit.
- **SC6 — The mirror is safe and reversible.** MCP args are replaced, not unioned; TOML multi-line strings and stale subtables are handled; the credential stripper catches the new shapes (Claude and Codex); safe mode blocks command-running env; no symlink-following stat/realpath before the ancestor checks; dotted `projects.*` trust entries never cross; dotfile-symlinked configs mirror. Provenance records every write; primary deletions propagate (only unedited, mirror-written items); originals are backed up before the first overwrite; **Restore** puts an account back; the save-time preview asks before overwriting or removing. Path: stack create/edit route and `mirrorForSwap` → `mirrorStack`; `POST /harness-stacks/mirror-preview`; `POST /harnesses/:id/mirror-restore`. Tests: harness-mirror unit, server route tests, settings e2e.
- **SC7 — Transfers never fail on size or lose context.** No transcript cap; `file-history/<sid>` is copied; sidecar truncation and errors become warnings; the transcript is found by session-id scan (long hashed paths); handoff paths are recorded before the copy; cleanup is tied to the session id and survives a root change. Tests: harness-session-transfer unit.
- **SC8 — Swap history.** Every move (limit, retry incl. same-account, manual, scheduled, unavailable, boot-resume) and every blocked outcome writes one row. Settings and `agetor harness stack history` page through it. Path: each move path → `harnessSwapEvents.insert`; `GET /harness-stacks/:id/history`. Tests: orchestrator/failover units per path, server route test, CLI test, e2e (history after a swap).
- **SC9 — Switch to next account.** Idle task: moves now to the next usable member (no cooldown, not tried). Live run: the switch is scheduled and happens when the turn ends, unless the user pressed Stop. It can be cancelled, survives a restart, and with no usable target is refused up front (409 with per-member reasons). Path: RunPanel button / `agetor switch-account` → `POST /tasks/:id/switch-account` → orchestrator. Tests: orchestrator unit, server test, CLI test, e2e.
- **SC10 — Surfaces.** Merged Harnesses page with stack groups, per-member quota, cooldown reason/message + Clear, history, preview, Restore; RunPanel picker limited to stack members for a stacked task, with a pending state; banners showing the earliest reset, per-member reasons and a link to Harnesses; NewTaskForm hint; CLI parity (markers in `ls`, stack ref resolver, `edit --add/--remove/--move`, cooldown clear, history, restore, switch-account, preview); optimistic concurrency on stack edits; same-stack switch without timeouts; all the review nits. Tests: unit + e2e listed in §5.

## 2. Context & constraints

- **Repo rules (CLAUDE.md):**
  - Every route needs a `ROUTE_POLICY` entry (`src/bun/route-policy.ts`).
  - A CLI-reachable path-taking route needs `pathParams` or an exemption.
  - Spawns go through `coreSpawn`.
  - Agent-writable files are read no-follow.
  - Server-managed `tasks` columns (`harness_state`) are written only through targeted UPDATEs (`updateTaskState`/`patchTaskState`).
  - Every `run_events` query must SEARCH.
  - `src/shared` has no runtime imports from either process.
  - The Bun main thread is shared, so long work is cooperative.
  - WKWebView has a 6-connection budget, so there is no new SSE.
  - CLI text goes through `terminal-text.ts`.
  - The UI uses semantic color tokens only.
  - `RunPanel` resets per-task state on `task.id`.
  - A popover carries `data-popover-open` and handles Escape.
  - No FK to `harnesses` (migration 085; peer memory `272b7845`).
- **Harness-stack conventions (peer memory `272b7845`):**
  - One config-root resolver (`src/bun/harness-config-root.ts`).
  - Every account move goes through `moveTaskToMember` (`src/bun/harness-failover.ts`).
  - Codex limits come only from `turn.failed`.
  - User text that is exactly the hidden continuation wrapper is refused.
- **Finding anchors** (verified this session; see the finding map in §4):
  - `orchestrator.ts:4107` (claim-held branch);
  - `orchestrator.ts:1316` and `:6174` (boot);
  - `orchestrator.ts:5176` (unconditional clear);
  - `harness-stacks.ts:931` (`clearLimitState`);
  - `harness-failover.ts:197` (`task.model` null);
  - `harness-limits.ts:352` (time-only reset);
  - `harness-mirror.ts:548/688` (`deepMerge` union);
  - `harness-session-transfer.ts:50` (64 MB cap);
  - `server.ts:6138` (awaited switch with no timeout lift);
  - `api-client.ts:573-602` (unencoded ids).
- **Investigation facts:**
  - The latest migration is **086**, so this change adds **087**.
  - Usage snapshots: `harness_usage`, `GET /usage` (CLI scope), the App-level `usage` map fed by the `harness_usage` app event (`App.tsx:286/892/1364`).
  - `POST /harnesses/:id/usage/refresh` is **app-only by design** (it can trigger a cross-app Cursor read; peer entry `de29c77c`).
  - Nothing persists swap events today.
  - Mirror write points: `harness-mirror.ts:299/344/507-523/655/707/~761/~984`.
  - `splitTomlBlocks` (`:1080`) has no multi-line string state.
  - Claude's `file-history/<sid>/` is keyed by session id (checked on disk).
  - Claude hashes project-dir names over 200 chars with an unknown input (`claude-tmux.ts:527`), so the transfer finds the source by scanning `projects/*/<sid>.jsonl`.
  - `HARNESS_STACK_RETRY_MIN_MS = 10_000` is hard-coded (`harness-failover.ts:32`).
  - The e2e fixture wires only the Claude fake driver (`e2e/fixtures.ts:533/548`).
  - Settings sections: `src/mainview/lib/settings-dialog-view.ts:4`.
  - The editor sub-page view is `stack-editor`.
- **Tooling:**
  - typecheck: `bun run typecheck`.
  - Unit tests: `bun test` (export `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` first).
  - e2e: `bun node_modules/@playwright/test/cli.js test <spec>`, one Playwright run at a time.
  - No CI workflows exist, so these three are the gates.
  - Known pre-existing failures: tmux-socket ×2 and reconcile cancel on main (memory).

## 3. Approach & key decisions

Owner decisions are from the grill; the rest are reasoning.

| # | Decision | Source |
| --- | --- | --- |
| D1 | **Claim-held limit (item 1).** If the claim belongs to this task's own swap window or boot swap claim, the signal is queued (`deferredLimitSettlements`) and settled when the claim is released. Otherwise the run takes the normal settle (passthrough). A run is never marked failed without its column being decided. | reasoning |
| D2 | **Boot (item 2).** `reconcileOrphans` does not orphan a running run that is the `runId` of a non-manual `pendingSwap`. It records that run `failed` with `reason:"harness-swap"`, leaves `tasks.run_id`/column alone and emits no `orphaned` run-status, so the swap reconcile resumes it. Defensive: `task.runId == null && runs.latestForTask == pending.runId` also counts as "no successor minted". | reasoning |
| D3 | **Follow-ups (items 3/4).** One helper stashes, to the backlog, every follow-up a handled ending leaves without a started successor: the Codex `codexTurnQueue`, undelivered mid-turn rows and `swapFollowUps`. A clean-retry arm persists `allExhausted.cleanRetryOf = oldRunId`. Its cancel, manual-message reset and cap paths recompute the unread follow-ups from `cleanRetryParts(runs.mainUserRows(cleanRetryOf))` (persisted, crash-safe; echo↔twin paired by `line_uuid`) and stash them. | reasoning |
| D4 | **Cooldown clear (item 5).** `clearLimitState(harnessId, { startedAtMs, model })` deletes only rows with `updated_at <= startedAtMs` for the account-wide row and the run's model. | review |
| D5 | **Per-model Codex cooldown.** `harness_limit_state` gains `model` ('' = account-wide; table rebuilt in 087, PK `(harness_id, model)`, still no FK). `HarnessLimitSignal.model?` comes from "usage limit for <model>". Selection skips a member for a task whose resolved model matches, or for any account-wide row. | owner (grill r1 `codex-per-model`) |
| D6 | **Swap history.** New table `harness_swap_events`, FK `stack_id → harness_stacks ON DELETE CASCADE`, **no FK** to tasks or harnesses. Labels and the task title are denormalized, so history survives task delete, archive and account delete, and is removed with the stack. **No cap**: paged by `(at DESC, id DESC)` cursor, index `(stack_id, at DESC, id DESC)`. Events: limit, retry (incl. same-account), manual, scheduled, unavailable, boot-resume, blocked. | owner (r1 `history-lifetime`, `history-events`; r2 `history-cap-why`) |
| D7 | **Mirror provenance.** New table `harness_mirror_provenance`, PK `(harness_id, path, key)`, no FK. Columns: `scope` file/key/link, `value_hash`, `src_mtime_ms`, `src_size`, `preexisted`, `backup_ref`, `stack_id`, `updated_at`. DB, not a file in the agent-writable account root. Rows are untrusted on use, like handoff rows: removals pass the same checks as `removeCopiedPaths` plus a mirror-allowlist shape check and a hash match. | reasoning (investigation §2) |
| D8 | **Deletion propagation.** Something the mirror wrote, that the primary no longer has, and whose current hash still matches is removed. If the backup edited it, it is kept with a warning and its provenance is dropped. A `preexisted` item is never removed. | owner (r1 `provenance-edited`) |
| D9 | **Backups + Restore.** The first time a write would replace or remove something the backup already had, the original is copied to `<dataDir>/mirror-backups/<harnessId>/…` (dirs 0700, files 0600, atomic); a key backup is a JSON file under `keys/`. **Restore** (`POST /harnesses/:id/mirror-restore`, `agetor harness restore <account>`, a button on the account row) does three things: (1) puts every backed-up original back; (2) removes mirror-added items that are still unedited; (3) drops that account's provenance. A current backup member gets a confirm warning that the next mirror re-applies. Harness delete removes the account's backups and provenance. | owner (r1 `mirror-backups`) |
| D10 | **Preview.** A dry run (`POST /harness-stacks/mirror-preview`, body = draft + optional `stackId`) returns per backup: files add/update/remove, keys changed (names only, never values), and items that would be backed up. The webview Save shows the preview dialog **only when something on a backup would be overwritten or removed**. The CLI `create/edit --dry-run` prints it, and without `--yes` a write that would overwrite or remove refuses and prints the preview. | owner (r1 `mirror-preview`) |
| D11 | **Safe mode.** Switching full → safe drops provenance for keys safe mode no longer mirrors, without deleting anything on the backup. | owner (r1 `safe-mode-unown`) |
| D12 | **Switch to next account.** `POST /tasks/:id/switch-account`. **Idle:** move now through the existing same-stack switch path to `planManualSwitchTarget` (forward from current, wraps; no cooldown, not marked tried). **Live run:** persist `harnessState.scheduledSwitch = { requestedAt }`. When the turn ends succeeded/failed/orphaned, run the same move; on a user Stop, drop it with a status line; a provider limit in the meantime is handled by failover, which clears it. `DELETE /tasks/:id/switch-account` cancels. Refused up front (409 with per-member reasons) when no target is usable, and (409) when background agents hold the task. History trigger `scheduled` / `manual`. | owner (r1 `switch-now-live` = after turn; r2 `switch-idle`, `switch-scheduled-end`; confirm `switch-now-none`, `manual-no-cooldown`) |
| D13 | **Clear cooldown.** `DELETE /harnesses/:id/limit-state` (optional `?model=`), app+cli, account-global. The UI confirm says the provider may still refuse. | owner (r1 `clear-cooldown`) |
| D14 | Cooldowns show reason + provider message: message as plain text in a detail line or tooltip in the webview, `escapeFreeText` in the CLI. | owner (r1 `cooldown-message`) |
| D15 | **Quota.** The webview uses the App `usage` map (no new fetch); the CLI uses `GET /usage`. Each shows a compact 5 h/weekly meter per member and the snapshot age, stale past 20 min. No force refresh from the CLI. | owner (confirm `quota-display`) |
| D16 | **Optimistic concurrency.** `HarnessStackInput.expectedUpdatedAt?` → 409 `{code:"stack-changed", stack}` on mismatch. Webview: toast "This stack changed elsewhere — reloaded", then the editor reloads. CLI `stack edit` always sends the `updatedAt` it just fetched. | owner (confirm `stack-concurrency`) |
| D17 | CLI stack refs resolve as exact id → exact label → unique id prefix. A duplicate label is an error listing both ids. | owner (confirm `cli-lookup`) |
| D18 | **Picker.** For a stacked task the RunPanel account picker lists **only the stack's members**, with position, cooling mark and a pending state during the awaited copy. The CLI `agetor edit --agent` still accepts any account. | owner (r2 `picker-scope`) |
| D19 | **Settings merge.** Harnesses renders each stack as a card of its accounts (primary first), then "Other accounts". The Stacks sidebar entry is removed. Old `stacks` deep links open Harnesses. The editor sub-page stays (order, members, mirror mode, preview, Restore) and so does History. | owner (r3 `stacks-placement`) |
| D20 | **Retry test seam.** `AGETOR_HARNESS_RETRY_MIN_MS`, honored only under `NODE_ENV=test` or the e2e backend's flag. | owner (r1 `retry-test-seam`) |
| D21 | **Quota exhaustion.** A snapshot is exhausted when any blocking window is at 100% and no credits meter has headroom. The reset is the latest exhausted window's. | owner (confirm) |
| D22 | **Cloud env login evidence.** Cloud env keys count as Claude login evidence only with a selector, and then as `null` (unknown). | owner (confirm) |
| D23 | **Banners.** `planExhausted` persists `allExhausted.memberReasons: {harnessId, reason}[]`. Banners and the CLI show the earliest reset and those reasons, and link to Settings → Harnesses. | reasoning |
| D24 | **Delivery.** One branch `fix/harness-stacks-fix-round`, one commit per wave, nothing pushed. | owner (r1 `delivery`) |

Rejected alternatives:
- Interrupting a live turn for switch-now (owner chose after-turn).
- A per-task-only cooldown for per-model limits.
- A provenance file inside the account root (agent-writable).
- Deriving history from `run_events` (unindexed cross-task scan, violates the SEARCH rule).
- Keeping a separate Stacks page.

## 4. Work breakdown — implementation tasks

**Wave 0 — contract (orchestrator, inline).** Owns `src/shared/types.ts` only. It adds the types every later task builds on and extends `parseTaskHarnessState` for the new optional fields (risk: state):

- `HarnessLimitSignal.model?: string | null` and `HarnessLimitState.model: string | null`.
- `HarnessStackInput.expectedUpdatedAt?: number`.
- `TaskHarnessState.scheduledSwitch?: { requestedAt: number } | null`.
- `allExhausted.cleanRetryOf?: string`.
- `allExhausted.memberReasons?: { harnessId: string; reason: string }[]`.
- `lastMove.reason` gains `"switch-now"`.
- `HarnessSwapTrigger` = `"limit"|"retry"|"manual"|"scheduled"|"unavailable"|"boot-resume"|"blocked"`.
- `HarnessSwapEvent` and `HarnessSwapHistoryPage { events, nextCursor }`.
- `MirrorPlan` / `MirrorPreview` (per backup: `files:{add,update,remove}`, `keys:{file,key,action}[]`, `backups:string[]`, `warnings`) and `MirrorRestoreResult`.
- `SwitchAccountResult = {status:"switched", task} | {status:"scheduled", task}`.
- `SwitchAccountRefusal {code:"no-usable-member", reasons}`.

| ID | Wave | Goal | Owns (exclusive in its wave) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- |
| T1 | 1 | Shared pure logic: items 6, 7, 8, 11 (classifier extracts `model`), adjacent-only dedupe in `composeCleanRetryText`; helpers `memberStateText`, `memberReasonText`, `formatHarnessSwapEvent`, `quotaSummary(meters)`, all used by CLI + webview; `stackPositionText` stays the single 1-member rule | `src/shared/harness-stack.ts`, `src/shared/harness-limits.ts`, `src/shared/user-message.ts` (composeCleanRetryText only), their `.test.ts` | state | T5/T7/T6/T9 import them |
| T2 | 1 | DB: migration 087 (rebuild `harness_limit_state` with `model`; `harness_swap_events`; `harness_mirror_provenance`); stores `harnessSwapEvents` (insert, page by cursor, delete by stack via FK) and `mirrorProvenance` (upsert, list, delete by harness, delete keys). `harness-stacks.ts`: per-model limit state, conditional clear (D4), `update` with `expectedUpdatedAt` → `StackChangedError`, item 10, Claude catalog warning nit, `harnesses.delete` also drops provenance rows | `src/bun/migrations/087_harness_stacks_fix_round.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/harness-stacks.ts`, new `src/bun/harness-swap-history.ts`, new `src/bun/harness-mirror-provenance.ts` | migration, data | T3/T5/T7/T8 |
| T4 | 1 | Transfer + cleanup: items 15 (transfer half), 16 (remove cap), 17 (`file-history/<sid>`, sidecar warnings), 18 (record intended paths before copying; delete row only after unlink; tie shapes to the recorded sid; a root change keeps the row), session-id scan lookup | `src/bun/harness-session-transfer.ts`, `src/bun/harness-file-transfer.ts`, `src/shared/harness-mirror.ts` **handoff-shape section only** (`CLAUDE_SESSION_SIDECAR_DIRS`, `isHandoffCopyShape`, `isHandoffPrunableDir`) | trust, data | existing `moveTaskToMember` callers |
| T3 | 2 | Mirror: items 12, 13, 14, 15 (mirror half), dotted `projects.*` (item 22), dotfile-symlinked top-level config files, per-project `.claude.json` MCP servers; provenance recording at every write point; deletion propagation (D8); backups (D9); dry-run plan (D10); exports `previewMirror(draft, {stackId?})`, `restoreMirror(harnessId)`, `removeMirrorBackups(harnessId)`; safe-mode un-own (D11) | `src/bun/harness-mirror.ts`, `src/shared/harness-mirror.ts` (policy sections), new `src/bun/harness-mirror-backup.ts` | trust, data | stack routes (T8), `mirrorForSwap` (existing) |
| T5 | 2 | Failover: item 9, item 22 (1-member inert in `prepareTaskHarness`), D20 env seam, per-model cooldown in selection, `memberReasonsFor(stack, task)`, `planManualSwitchTarget(task)` (D12), `moveTaskToMember` takes a `history` descriptor and writes one `harnessSwapEvents` row when moved; `prepareTaskHarness` moves record trigger `unavailable` | `src/bun/harness-failover.ts` | state, concurrency | T7, T8 |
| T7 | 3 | Orchestrator: items 1–5 (D1–D4), stack-delete cancel export (item 22), history rows on every move and blocked path, per-model signal into `setLimitState`, `memberReasons` into `allExhausted`, `cleanRetryOf`, switch-now: `switchTaskAccountNow(taskId)` / `cancelScheduledAccountSwitch(taskId)` plus scheduled-switch settle and boot handling (D12) | `src/bun/orchestrator.ts` | state, concurrency | T8 routes; boot in index/headless (existing) |
| T8 | 3 | Server + clients: routes `DELETE /harnesses/:id/limit-state`, `GET /harness-stacks/:id/history`, `POST /harness-stacks/mirror-preview`, `POST /harnesses/:id/mirror-restore`, `POST`/`DELETE /tasks/:id/switch-account`; stack PATCH 409 (D16); item 19 (`server.timeout(req,0)` on same-stack PATCH and switch-account); stack DELETE cancels armed retries with a status line; harness delete removes backups; `limitStates` carry `model`; ROUTE_POLICY entries (+ `gateStackMemberRoots` on preview/restore/switch for CLI callers); `api.ts` + `api-client.ts` methods (item 20 encoding; long budget + "may have gone through" for switch/edit-agent) | `src/bun/server.ts`, `src/bun/route-policy.ts`, `src/mainview/lib/api.ts`, `src/cli/api-client.ts` | trust, external | webview (T9a/T9b), CLI (T6) |
| T6 | 4 | CLI parity: one-member rule → `stackPositionText` (harness.ts:31, ls.ts:111, show.ts:77, tui/Dashboard.tsx:103); stack ref resolver (D17); `stack edit --add/--remove/--move`, `--dry-run`, `--yes`; `stack history [--limit] [--before]`; `harness cooldown clear <account> [--model]`; `harness restore <account>`; `switch-account <task> [--cancel]`; markers in `ls`; cooldown reason + message, quota (GET /usage) in `harness ls`/`stack ls/show`; earliest reset + member reasons in `show`, pointing at Harnesses; `cmdEdit --agent` long budget; escape harness ids in `harness ls` and the `ls` agent cell; 409 handling; usage/help text | `src/cli/commands/*.ts` (harness, ls, show, manage, logs, new switch-account), `src/cli/index.ts`, `src/cli/usage.ts`, new `src/cli/resolve-stack.ts`, `src/cli/tui/Dashboard.tsx`, `src/cli/notify.ts` | none | `src/cli/index.ts` dispatch |
| T9a | 4 | Settings: merged Harnesses page (D19) with stack cards, per-member quota (App usage map passed down), cooldown reason/message + Clear (confirm), Restore (confirm), History view (paged), editor sub-page with preview dialog (D10), 409 reload (D16), kind-switch confirm when members exist, Save-with-no-changes feedback, removal of the Stacks section (old deep link → Harnesses) | `src/mainview/components/settings/SettingsDialog.tsx`, `HarnessStacksSection.tsx` (restructured or split into new files under `components/settings/`), `src/mainview/lib/settings-dialog-view.ts`, `src/mainview/lib/stack-editor.ts` | none | SettingsDialog (existing) |
| T9b | 4 | RunPanel & board: picker limited to stack members + pending state (D18); "Switch to next account" button + scheduled state + Cancel; non-editable Harness row shows the label; banner shows earliest reset + member reasons + "Open Harnesses" link; Run now in-flight guard; NewTaskForm `stackBackupCanServe` hint; StackBadge `aria-label`; swap toast/headless notification omit position for 1-member stacks; fix the `task-patch-failure.ts` comment vs retry; App threads `usage`/`openSettingsHarnesses` | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/harness-stack-banner.ts`, `src/mainview/App.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `StackBadge.tsx`, `src/mainview/lib/stack-badge.ts`, `src/mainview/lib/toasts.ts`, `src/mainview/lib/task-patch-failure.ts`, `src/bun/headless-notifications.ts` | none | App (existing) |
| T10 | 5 | Docs: `harness-stacks.md` (Model, Selection, Limits, Settlement, Mirror, Cleanup, Manual paths, Surfaces, Known limitations, new History/Provenance/Switch sections), `persistence.md` (087), `security.md` (provenance trust, backups store), `run-panel.md`, `testing-seams.md` (retry seam, Codex fake driver), `CLAUDE.md` env-var list + topic map | `docs/architecture/*.md`, `CLAUDE.md` | none | — |

**Finding map** (each finding → the task that fixes it → the test that proves it; regression tests are written in Phase 6):

| Finding | Title | Task | Regression test |
| --- | --- | --- | --- |
| 1 | Card stuck `running` when a limit lands while the claim is held | T7 | orchestrator: limit during held-follow-up delivery and during the boot claim |
| 2 | Crash mid-swap blocks instead of resuming | T7 | orchestrator: old run left `running` → boot → resumed, pipeline step not settled |
| 3 | Codex queued follow-ups stranded or out of order | T7 | orchestrator: blocked/Stop/failed-spawn endings stash the codex queue |
| 4 | Clean-retry follow-ups lost | T7 (+T0 type) | orchestrator: cancel, manual message and cap paths stash the follow-ups |
| 5 | A success that started before the limit clears the cooldown | T2 + T7 | store + orchestrator |
| 6 | Expired tried member ignored | T1 | shared/harness-stack |
| 7 | A just-passed time-only reset becomes +24 h | T1 | shared/harness-limits |
| 8 | Quota snapshot check never fires; wrong reset | T1 | shared/harness-limits (fixes the test at :250) |
| 9 | Default model skips the catalog and CLI floor | T5 | harness-failover |
| 10 | Cloud env counts as login evidence | T2 | harness-stacks |
| 11 | Per-model Codex limit cools the account | T1 + T2 + T5 + T7 | limits + store + selection |
| 12 | MCP `args` arrays unioned | T3 | harness-mirror |
| 13 | TOML multi-line, stale subtables, deletions | T3 | harness-mirror |
| 14 | Credential and safe-mode gaps | T3 | shared + bun harness-mirror |
| 15 | Symlink-following stat/realpath before checks | T3 + T4 | mirror + transfer |
| 16 | Transcript cap | T4 | transfer: a >64 MB transcript copies |
| 17 | file-history + silent sidecar truncation | T4 | transfer |
| 18 | Cleanup leaks | T4 | transfer: crash-before-upsert, root change, sid tie |
| 19 | Switch PATCH timeout | T8 + T6 | server (timeout lifted) + CLI budget |
| 20 | Unencoded stack ids | T8 | api-client |
| 21 | No optimistic concurrency | T2 + T8 + T9a + T6 | store, server 409, UI, CLI |
| 22a | 1-member stacks not inert | T5 | failover |
| 22b | Stack delete leaves a silent countdown | T8 + T7 | server |
| 22c | Dotted `projects.*` crosses | T3 | mirror |
| 22d | One-member rule duplicated | T6 | CLI tests |
| Gaps | Cooldown reason + Clear; banners; mirror confirm (preview); CLI parity; picker; NewTaskForm; e2e; nits | T6/T8/T9a/T9b/T3 | unit + e2e (§5) |
| Features | Provenance/backup/restore, history, quota, switch-now, settings merge | T2/T3/T5/T7/T8/T6/T9a/T9b | unit + e2e (§5) |

## 5. Work breakdown — test tasks (Phase 6)

**e2e applies.** These are user-visible flows that cross the webview → core → filesystem boundary. Recipe:
- Start: `bun node_modules/@playwright/test/cli.js test <spec>`. The fixture spawns a headless core per worker with its own `AGETOR_DATA_DIR` and the Claude fake driver.
- This change adds `AGETOR_CODEX_DRIVER=fake` wiring and `AGETOR_HARNESS_RETRY_MIN_MS` to `e2e/fixtures.ts`.
- One Playwright run at a time.

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| TT1 | unit | T1 (items 6, 7, 8, 11, dedupe, helpers) | `src/shared/harness-stack.test.ts`, `harness-limits.test.ts`, `user-message.test.ts` |
| TT2 | unit/integration | T2 (migration 087 up incl. rebuilt limit table with existing rows, stores, conditional clear, per-model, StackChangedError, item 10, EXPLAIN SEARCH for the history page query) | `db-harness-stacks.test.ts`, `harness-stacks.test.ts`, `migrate.test.ts`, new `harness-swap-history.test.ts`, new `harness-mirror-provenance.test.ts` |
| TT3 | unit | T3 (each mirror bug, provenance, propagation incl. edited-keep, backups, restore, preview, safe un-own, symlink/TCC refusals) | `src/bun/harness-mirror.test.ts`, `src/shared/harness-mirror.test.ts` |
| TT4 | unit | T4 (no cap, file-history, sidecar warnings, sid scan, pre-recorded paths, root change, sid tie) | `harness-session-transfer.test.ts`, `harness-file-transfer.test.ts` |
| TT5 | unit | T5 (item 9, 1-member inert, seam, per-model selection, member reasons, manual target, history descriptor) | `harness-failover.test.ts` |
| TT6 | unit | T7 (findings 1–5 regressions, history rows per path, scheduled switch: success/failure/Stop/limit/boot, idle switch, refusal) | new `orchestrator-harness-fix-round.test.ts` |
| TT7 | integration | T8 (every new route, ROUTE_POLICY, CLI-token gates, 409s, timeout lift, encoding) | `server-harness-stacks.test.ts`, `route-policy*.test.ts`, `src/cli/api-client.test.ts` |
| TT8 | unit | T6 | `src/cli/harness.test.ts`, `ls.test.ts`, `show.test.ts`, `usage.test.ts`, new `resolve-stack.test.ts`, `Dashboard.test.tsx` |
| TT9 | unit | T9a/T9b pure libs | `stack-editor.test.ts`, `harness-stack-banner.test.ts`, `stack-badge.test.ts`, `task-patch-failure.test.ts`, `settings-dialog-view.test.ts` |
| TT10 | e2e | Merged Harnesses page: stack card, create/edit/reorder, preview dialog on overwrite, 409 reload, Clear cooldown, Restore, History after a swap, quota meter (seeded via `seedHarnessUsage`) | `e2e/harness-stack-settings.spec.ts` (rewritten) |
| TT11 | e2e | All-exhausted banner + earliest reset + member reasons + Run now; retry-running banner; manual same-stack switch from the picker (stack-only list) + 409 toast; Switch to next account idle + scheduled + cancel; stack delete during an armed retry; a Codex stack swap | `e2e/harness-stack-swap.spec.ts` (+ new `e2e/harness-stack-switch.spec.ts`), `e2e/fixtures.ts` |

Every test must be able to fail. Each regression test for findings 1–22 is shown red against the pre-fix code, either by temporarily reverting the fix in a scratch copy or by running against the base SHA.

## 6. Execution waves

- **W0** contract types (inline) → commit.
- **W1** T1 ‖ T2 ‖ T4 → barrier, wave review (data/migration/trust) → commit.
- **W2** T3 ‖ T5 → barrier, wave review (trust/state) → commit.
- **W3** T7 ‖ T8. T8 codes against T7's exported signatures, which are fixed here:
  - `switchTaskAccountNow(taskId): Promise<SwitchAccountResult>`, which throws `SwitchAccountRefusedError{status, body}`;
  - `cancelScheduledAccountSwitch(taskId): Task`;
  - `cancelHarnessRetryForTask(taskId, line?)`, now exported.

  Then barrier, wave review (state/concurrency) → commit.
- **W4** T6 ‖ T9a ‖ T9b → barrier → commit.
- **W4.5** wiring audit + sweep.
- **W5** T10 docs → commit.

Phase 5 review (opus, parallel dimension and flow passes) → Phase 6 tests (TT1–TT11, partitioned by file) → Phase 7 run (typecheck + `bun test` + e2e) → Phase 8 fixes.

## 7. Invariants, runtime shape & risks

**Invariants**

| Invariant | Enforced in |
| --- | --- |
| Every account move goes through `moveTaskToMember`, which writes the history row. Blocked outcomes are written by the orchestrator's block path. | `harness-failover.ts` |
| `harness_state` writes go only through `updateTaskState`/`patchTaskState`. | orchestrator |
| Only a provider limit sets a cooldown; a manual or scheduled switch never cools an account or marks it tried. | `settleHarnessLimitInClaim` / `recordLimitSignal` |
| Mirror never copies login material (allowlist + stripper). | `src/shared/harness-mirror.ts` |
| Provenance or handoff rows never authorize removing a path that fails the shape, ancestor, no-symlink and regular-file checks. | `removeCopiedPaths`-equivalent in `harness-file-transfer.ts` |
| Backups live under the data dir, never inside an account root. | `harness-mirror-backup.ts` |
| A task's start claim (`startingTaskIds`) is held for every account move, including the scheduled switch at settle. | orchestrator |
| A run is never recorded failed without its column being decided. | settle paths |
| A CLI-token caller gets the path gate on every route that touches account roots: preview, restore, switch, same-stack PATCH. | `gateStackMemberRoots` |

**Runtime shape**
- Exactly one core owns the port.
- Long work (mirror trees, transcript copies, provenance diff) stays cooperative (~20 ms slices).
- A crash between steps resumes from persisted state: `pendingSwap`, `scheduledSwitch`, `allExhausted` and the pre-recorded handoff paths.
- On a launch freeze, scheduled switches persist for the next owner.

**Blast radius**
- Migration 087 rebuilds `harness_limit_state`, which is safe because nothing references it by FK.
- The Settings layout changes: the Stacks section is gone.
- New routes.
- Webview e2e specs are rewritten.
- Rollback: revert the branch. 087 is additive except the limit-state rebuild, which keeps the rows with `model = ''`.

**Risks**
- `orchestrator.ts` (12k lines) concentrates T7. The wave review targets it.
- Provenance diffing on large plugin trees is mitigated by size/mtime fast paths.
- Preview accuracy must match the real run: one code path with a write sink.

## 7a. Carried from the wave reviews

- **W1 review S2.** Waves 1–3 form one unit, so no intermediate wave commit is run on its own. T5 matches per-model cooldowns against the task's resolved model (`task.model ?? DEFAULT_MODEL[kind]`, lower-cased). T7 passes `{ startedAtMs, model }` to `clearLimitState`. T9b keys `limitStates` by `harnessId` + `model` in `App.tsx` `reconcileById`, and shows a per-model cooldown as "cooling for <model>" (`TaskCard`, Settings).
- **W1 review S3.** T7 replaces `cleanRetryPartsOf` with `cleanRetryParts(runs.mainUserRows(runId), …)`.
- **W1 review N6/N7 (T10 docs).**
  - Retained copies (left after a root change) are lost when their task is deleted.
  - `harness_swap_events` cascades on `harness_stacks`, so a future `harness_stacks` table rebuild must turn foreign keys off, or it wipes the history.

- **W1 review S6 residual (T10 docs, Known limitations).** When a handoff row is re-keyed to a new session on the same account, old-session paths that can't be removed stay on disk and in the row under a session id they no longer match, so cleanup skips them. Fixing it needs a per-session handoff store, which is out of scope.

- **W2 review M3 (orchestrator decision).** An item the backup edited after the mirror wrote it is still overwritten (primary wins), but reversibly. The edit is backed up first, its row is marked `preexisted`, and it appears in `plan.backups`, so the preview asks before saving and Restore can bring the edit back.
- **W2 review N6 (T10 docs, Known limitations).** If the primary's merged file (`settings.json` / `config.toml`) is deleted outright, key removals do not propagate.
- **W2 review N3 (T7 contract).** `prepareTaskHarness` moves already record their history through `moveTaskToMember`'s `history`. T7 records limit, retry and boot swaps at `spawnSwapContinuation`, records manual and scheduled switches through `history`, and must never record the same move twice.

- **W3 review decisions (orchestrator):**
  - **Stop during a switch or scheduled-switch copy:** the copy finishes, and queued follow-ups are stashed to the tray rather than drained.
  - **Background agents still hold the task at turn end:** the scheduled switch is deferred until they release it.
  - **Message arrives while a scheduled switch holds the claim (pipeline reminders included):** it is held and delivered after the move, never refused.
  - **Second consecutive clean retry:** its follow-ups are recovered from the original run of the chain.
  - **Codex self-clear:** matches the exact stored cooldown row.
  - **Boot resume throws:** the task is blocked with `harness-swap-failed`.

- **Phase 5 review decisions (orchestrator):**
  - **Switch-now during a swap, retry or boot-swap window, or during a launch freeze:** refused with 409 (`busy` / `launches-frozen`). It is never scheduled, so a request can't be silently dropped.
  - **Clear cooldown:** re-arms the countdowns of blocked tasks waiting on that account and refreshes their member reasons.
  - **Clear on the account-wide chip:** clears only the account-wide row. Plain `DELETE` (CLI `cooldown clear` without `--model`) still clears every row.
  - **Restore:** offered only on accounts that have mirror records (`mirrorRestorable` in the `/harnesses` payload).
  - **Harness delete:** removes its provenance rows and backups inside the destination's mirror queue.
  - **Archived refusal:** uses code `archived`.
- **Accepted without change:**
  - `AGETOR_E2E_HARNESS_SEAMS` is an explicit opt-in e2e flag, set by the fixture.
  - Long-held webview connections for an awaited copy.
  - Large handoff path lists.
  - A boot-completed switch-now reads `manual-switch` (closed 2026-11-10: `pendingSwap.switchNow` keeps the label).
- **Phase 6:** rewrite the broken specs `harness-stack-settings`, `harness-stack-swap` and `settings-subpage-guard`.

## 8. Open questions / assumptions

- No unratified decisions: every grill question was answered by the owner.
- **Assumption.** The Restore action is available on any account with provenance. On a current backup member it warns that the next mirror re-applies.
- **Assumption.** The CLI `agetor edit --agent` keeps accepting outside-stack accounts (the picker restriction is webview-only, per r2).
- **Assumption.** The e2e backend flag for the retry seam reuses whatever e2e flag `e2e/fixtures.ts` already sets; if none fits, `AGETOR_E2E_HARNESS_SEAMS=1` is added and documented.
- **Assumption.** `switch-account` is the CLI verb (`agetor switch-account <task> [--cancel]`).

## 9. Completeness ledger

**In this run:**
- Findings 1–22 and every listed gap and nit (T1–T9b; see the finding map).
- Mirror provenance, backup and Restore (T2/T3/T8/T9a/T6).
- Swap history (T2/T5/T7/T8/T9a/T6).
- Per-member quota (T9a/T6).
- Switch to next account (T5/T7/T8/T9b/T6).
- The Settings merge (T9a).
- The retry seam and Codex fake-driver e2e wiring (T5, Phase 6).
- Docs and CLAUDE.md (T10).
- Existing data:
  - Migration 087 carries existing cooldown rows (`model = ''`).
  - Existing backups have no provenance, so their current files are treated as `preexisted` on the first mirror and backed up before any overwrite.
  - Existing handoff rows keep working, and the sid-tie check accepts their recorded shapes.

**Out of scope:**
- Returning to the primary after a reset (owner, chat).
- Interrupting a live turn for switch-now (owner chose after-turn).
- Mirror on a timer or file watch (plan §9 of PR #295, unchanged).
- A CLI force-refresh of usage (security decision `de29c77c`).
- Agent kinds other than Claude Code and Codex, and cross-kind stacks (PR #295 grill).

**Owner-deferred:** none.

### Ledger outcome (final)

- **Swept in:** every row above.
  - Findings 1–22, every gap and nit, and the five owner features (provenance with backup/Restore/preview, history, quota, switch to next account, Settings merge).
  - Everything the reviews found: the W1–W3 wave reviews and the Phase 5 four-pass review, 5 must-fix and 18 should-fix.
  - Five defects the tests found:
    - the data-dir link guard compared only one spelling of the path;
    - a credentialed inline shell env policy made the merge refuse;
    - mixed table/inline `set` forms;
    - identical unread follow-ups collapsed into one;
    - the restore message after a lost answer.
- **Ruled out of scope:** the rows marked out of scope above (return to the primary after a reset; interrupting a live turn for switch-now; a mirror timer/watch; CLI force-refresh of usage; other agent kinds and cross-kind stacks).
- **Known limitations closed after the final ledger** (owner asked to cover them, 2026-11-10; commits `c3b1453c`..`10fa8edc`, then `7319ea14` and the migration 089 commit):
  - re-keyed handoff rows and a deleted task's kept copies: migration 088 `harness_orphaned_copies`, swept at boot (with a normalization of pre-088 rows), after a transfer and after an account root edit; account delete collects them;
  - a deleted primary merged file now propagates key removals (merged as an empty document under the deletion-propagation rules);
  - the backup-removal directory-swap race: a spike showed the old walk, `/bin/rm -rf` and `find -delete` can all be redirected on macOS, while Bun's fd-relative `fs.rm` lost nothing; `removeMirrorBackups` uses it;
  - the mirror no longer follows an unexpected primary folder: migration 089 records the folder each backup's primary resolved to, and a change with unchanged account settings skips that backup's run with a warning (a vanished recorded folder, a re-pointed account or a full Restore resets the reference);
  - a boot-completed switch-now keeps its `switch-now` label (`pendingSwap.switchNow`).
- **Accepted known limitation**, documented in `harness-stacks.md`: an orphaned copy outside its account's current root waits until the root points back or the account is deleted (by design: the core never deletes outside an account's current root).
- **Owner-deferred:** none.

### Review round 2 (code review at `7f6383bd`)

A read-only code review of the branch at `7f6383bd` found 2 must-fix (R-M1, R-M2), 18 should-fix (S1–S18) and 10 nits (N1–N10). The owner asked to fix every one. Each fix has a regression test that was shown to fail without it. Code is in the working tree after `7f6383bd`; the final run is recorded in the Status row.

| ID | Finding | Disposition | Where fixed / tested |
| --- | --- | --- | --- |
| R-M1 | Removing every mirror-owned Codex top-level key could write the backup's old top block back while dropping the records | fixed: the old block is kept only when nothing is removed; otherwise the block is rebuilt from the backup's assignments minus the removed keys (comments kept), and a removed key still in the parsed result refuses the write | `harness-mirror.ts` `mergeCodexConfig`; `harness-mirror.test.ts` "R-M1: …" (×2) |
| R-M2 | A backup whose folder comes from the environment had its records applied to the wrong folder and its saved originals overwritten | fixed (owner: support such backups, pin them): migration 090 records the backup's folder(s) and fingerprint; same skip rule as the primary; a re-pointed backup or a gone recorded folder drops the old records and saved originals and mirrors as new; Restore refuses whenever the account resolves elsewhere; rows are untrusted (lexical, never stat'ed in a protected folder) | `harness-mirror.ts` `mirrorOne`, `folderSourceOf`, `movedRecordedFolder`, `firstFolderDifference`, `recordedFolderExists`, `dropMirrorState`, `restoreOne`; `harness-mirror-provenance.ts` `mirrorSources`; `090_harness_mirror_backup_folder.sql`; `harness-mirror.test.ts` "R-M2: …" (×5), `migrate.test.ts` "090 adds …" |
| S1 | Merged JSON files rewritten on every run (trailing-newline mismatch) | fixed: written only when the parsed document changes; a needed write keeps indentation, line endings and trailing newline (`renderJsonLike`, Restore too) | `harness-mirror.ts` `mergeJsonDoc`, `restoreJsonKeys`; "S1: …" (×2) |
| S2 | One failing file aborted the rest of its allowlist entry | fixed: per-file skip with a warning (5 listed, rest counted), registry left alone, propagation still runs; per-file cap = the tree's budget; a file over its cap is a skip in preview and run | `harness-mirror.ts` `copyEntry`, `mirrorFile`; "S2: …" (×2) |
| S3 | A nested member removed from a deep-merged settings object never reached backups | fixed for `extraKnownMarketplaces` (owned per name, `SETTINGS_NAMED_CONTAINERS`); other nested objects stay a documented known limitation | `harness-mirror.ts` `mergeClaudeSettings`; "S3: …"; `harness-stacks.md` Known limitations |
| S4 | A crash during a mirror add left the file unowned forever | fixed: intent row before the copy (files) and before `symlinkSync` (links), adopted by the equal-stamp branch | `harness-mirror.ts` `mirrorFile`, `linkTopLevelSymlinks`; "S4: …" (uses `holdMirrorForTests(…, "file-copied")`) |
| S5 | A sweep could forget the pending records of a transfer that started mid-sweep | fixed: monotonic `created_at` stamps, a sweep mark taken before listing, `forget(…, { notAfter })` | `db.ts` `harnessOrphanedCopies`; `harness-session-transfer.ts` `sweepOnce`; "a sweep never forgets the pending record … (review S5)" |
| S6 | Switch to next account from an account removed from its stack silently restarted the conversation | fixed: refused `not-in-stack`; a scheduled switch on such a task is dropped with a status line | `harness-failover.ts` `planManualSwitchTarget`; `orchestrator-harness-switch-now.test.ts` "an account removed from its stack (S6)" |
| S7 | A scheduled switch waiting for background agents was never applied after a failed turn (also when the holding start failed pre-run) | fixed: `settleWaitingScheduledSwitch` from `maybeReleaseHeldTask` (any turn outcome) and `releaseStartingClaim`; Stop on the holding start drops it; a throwing limit settlement drops it | `orchestrator.ts`; "a scheduled switch left waiting after its turn ended (S7)" (×3), "a limit settlement that throws … (S7)" |
| S8 | A resumed successor that hit a limit during the boot claim was blocked, then swapped anyway | fixed: a deferred settlement for the live successor counts as live; boot only clears the intent | `orchestrator.ts` `reconcileHarnessSwapInClaim`; `orchestrator-harness-fix-round.test.ts` "S8: …" |
| S9 | `harness stack edit` could mirror without the preview or `--yes` | fixed: only changed fields are sent (`stackEditPatch`); a no-change edit makes no request | `src/cli/commands/harness.ts`, `src/cli/usage.ts`; `src/cli/harness-stack.test.ts` (×4) |
| S10 | History "Load more" stuck on "Loading…" after Refresh | fixed: `historyReducer` (Refresh clears it; Load more waits for a refresh) | `StackHistory.tsx`; `StackHistory.test.ts` |
| S11 | Per-model cooldown tests passed even if the model was dropped | fixed (tests): assert the stored row's `model`; parser passthrough test | `orchestrator-harness-fix-round.test.ts` "finding 5", `src/shared/harness-limits.test.ts` |
| S12 | Account-delete-during-mirror tests could not fail on the queueing bug | fixed: deterministic pause `holdMirrorForTests(…, "after-copy")` | `harness-mirror.ts`; `harness-mirror.test.ts` "account delete: a mirror in flight stops writing …" and TT-C |
| S13 | Finding-1 tests did not check the fate of the held message | fixed (tests): it lands in the tray exactly once | `orchestrator-harness-fix-round.test.ts` "finding 1" |
| S14 | Untested guards: the 250 ms deletion recheck; the 089 guard for Codex and a HOME-only `.claude.json` move | fixed (tests) | "S14: …" (×3), `holdMirrorForTests(…, "primary-deletion-recheck")` |
| S15 | `persistence.md` and the 089 header said the folder guard gates only deletion propagation, and the header cited a nonexistent section | fixed (docs): whole-run skip; real heading cited (089 never shipped to main, so its header comment was corrected; no SQL changed) | `persistence.md`, `089_harness_mirror_sources.sql` header |
| S16 | The plan's Status row and ledger did not record this round | fixed: this section and the Status row | this file |
| S17 | Known limitation said an orphaned copy outside the root stays "until the account is deleted" | fixed (docs): account delete drops the records; the file stays on disk | `harness-stacks.md` Known limitations |
| S18 | Orphan and mirror-sources rows' trust was undocumented, and a planted orphan row could delete a live conversation | fixed: the sweep skips a session a task still resumes on the account (`liveOnRunsOfHarness`; index from migration 090); `security.md` states what each row is trusted for | `harness-session-transfer.ts` `sweepOnce`; "a planted record naming a session another task still resumes … (review S18)"; `security.md` |
| N1 | Restore `chmod`-ed after the rename (follows a swapped-in link) | fixed: mode applied to the temp file | `harness-mirror.ts` `restoreOne`; "N1: …" |
| N2 | Re-adding a deleted item wiped `preexisted`/`backupRef` | fixed | `mirrorFile`, `linkTopLevelSymlinks`; "N2: …" |
| N3 | Interrupted copies left `.agetor-tmp-*` files | fixed: `sweepStaleTempFiles` (exact name, files/links only, older than 1 h, once per folder per 10 min) | `harness-file-transfer.ts`, `harness-mirror.ts`; `harness-file-transfer.test.ts` (×4), "N3: …" |
| N4 | A failed transfer awaited its sweep behind the global chain while holding the start claim | fixed: fired, not awaited (`orphanSweepsSettled` for tests) | `harness-session-transfer.ts` `heldTransfer`; "a failed transfer returns without waiting … (review N4)" |
| N5 | Stack delete cancelled the retry or switch of a task whose account moved into another stack | fixed: tasks picked by the stack they resolve to now; others re-pointed first (`repointTaskStatesAwayFromStack`) | `harness-failover.ts`, `server.ts`; `server-harness-stacks.test.ts` "(N5)" |
| N6 | StackEditor's save closed whatever subpage was showing | fixed: `viewAfterSave`; dirty reported only while mounted | `SettingsDialog.tsx`, `StackEditor.tsx`; `SettingsDialog.test.ts` |
| N7 | `switch-account --cancel` said "cancelled" with nothing scheduled; the Switch button showed on archived tasks | fixed: route answers `cancelled`; CLI message; button hidden on archived tasks (Cancel kept); refusal heading only for `no-usable-member` (CLI and toast) | `server.ts`, `switch-account.ts`, `RunPanel.tsx` `SwitchAccountControl`, `task-patch-failure.ts`; `harness-stack.test.ts` (×3), `SwitchAccountControl.test.tsx`, `task-patch-failure.test.ts` |
| N8 | `snapshotHarnessState` did not restore the 088/089 tables; the boot switch-now `manual` label was untested | fixed: whole-row restore; label test added | `test-harness-state.ts`; `db-harness-stacks.test.ts` "(review N8)", `orchestrator-harness-switch-now.test.ts` "boot completion … (label)" |
| N9 | `run-panel.md` placed `switchingAgentFor`/`pickerNow` in `RunPanelBody` | fixed (docs): they are `TaskDetails` state | `run-panel.md` |
| N10 | Commit `44d2b47a` ("tests: …") carries production fixes | not a code change: recorded in the PR body, which lists the production fixes that commit carries | PR body |

Independent re-review of this round (before commit) found one should-fix and four nits:

| ID | Finding | Disposition | Where / test |
|---|---|---|---|
| RR-1 | A background agent finishing inside the done handler's watcher pump let the subagent edge claim the scheduled switch, so the follow-up queue drained under a held claim (a Codex follow-up taken off the queue was lost); S7 widened it to failed turns | fixed: a settling turn (`settlingTurnRuns`) makes `accountSwitchMustWait` wait; the turn-end path applies the switch, `endTurnSettle` applies one that became possible meanwhile | `orchestrator.ts`; `orchestrator-harness-switch-now.test.ts` "a background agent settling inside the turn-end pump (S7 race)" |
| RR-2 | `movedRecordedFolder` checked only the first differing recorded folder, so a gone config root hid a `.claude.json` folder that still exists and its originals were dropped | fixed: any differing recorded folder that still exists skips | `harness-mirror.ts` `folderDifferences`; "R-M2: a Claude backup whose old config root is gone but whose old .claude.json folder still exists …" |
| RR-3 | `atomicWriteFile` (and `copyRegularFileDetailed`) chmod-ed the temp file by path | fixed: mode set on the open handle | `harness-file-transfer.ts`; "temp-file mode is set by descriptor" |
| RR-4 | A recorded backup folder that merely vanished (unmounted volume) plus a different current resolution drops the account's saved originals | kept by decision: the records describe a folder the account no longer uses; keeping the originals aside would leak them with nothing able to restore them. Documented in `harness-stacks.md` and `security.md` | — |
| RR-5 | The 089 header comment was edited although dev databases applied 089 | accepted: comment only, 089 never shipped to main, `_migrations` tracks ids | — |

Docs updated for this round: `harness-stacks.md`, `persistence.md`, `security.md`, `run-panel.md`, `testing-seams.md`, the CLAUDE.md topic-map row (migrations 087–090) and the 089 header comment.

### Review round 3 (code review at `b7bbfce5`)

A read-only code review of the branch at `b7bbfce5` found 2 must-fix (M1, M2), 10 should-fix (S1–S10) and 10 nits (N1–N10). The owner asked to fix every one and settled two questions (below). Each code fix has a regression test that the fixing agent reported red without the fix. Code is in the working tree after `b7bbfce5`; the final run is recorded in the Status row.

**Owner decisions.**

- **Q1.** A failed turn whose background agents are still running is treated exactly like a succeeded turn held by background agents, on every path: an account switch (the turn end, the release edge, a claim release, boot, `switchTaskAccountNow`, a same-stack PATCH), Stop, archive, all-exhausted retries, the claude death watch and a manual prepare. It is refused or deferred, not scheduled, exactly as in the held case. One helper answers it everywhere: `backgroundAgentsHoldTask` (`isHeldByBackgroundAgents`, or running background agents with no live turn). The pipeline meaning (`isHeldByBackgroundAgents`: a succeeded step that has not settled) is unchanged.
- **Q2.** A re-pointed backup's records and saved originals are dropped per folder (M1), and only after the save-time confirmation (S2); they are not kept keyed by the old folder.

| ID | Finding | Outcome | Where fixed / regression test |
| --- | --- | --- | --- |
| M1 | Pinning a backup to the config folder it already used deleted that folder's saved originals (any recorded folder line that differed dropped every row and original; a symlinked spelling counted as a move) | fixed: each recorded folder judged on its own (`.claude.json` keys ↔ the `.claude.json` folder, everything else ↔ the config root), compared by resolved path; only the moved folder's rows and originals go (`dropFolderState`, `removeFolderBackups`, `mirrorProvenance.removeAllButPath`); Restore refuses only the moved folder's rows | `harness-mirror.ts` `mirrorOne`, `folderDifferences`, `sameRecordedFolder`; `harness-mirror.test.ts` "M1: pinning a Claude account to the config folder it already used keeps that folder's saved originals; …", "M1: a symlinked spelling of the same folder is the same folder: nothing is dropped"; `harness-mirror-provenance.test.ts` "removeAllButPath keeps only the named path's rows, of that account only" |
| M2 | After a restart, a scheduled switch waiting for a failed turn's background agents was applied at once, dropping the REPL that hosts them | fixed (Q1): boot, `applyScheduledSwitch` and every other edge ask `backgroundAgentsHoldTask`; the release edge applies the switch when the agents finish | `orchestrator.ts` `reconcileScheduledSwitchesAtBoot`, `applyScheduledSwitch`; `orchestrator-harness-switch-now.test.ts` "a FAILED turn's background agents hold a scheduled switch at boot (M2, Q1)" › "boot leaves the request alone until the agent finishes, then its release edge applies it" |
| S1 | The backup's folder record was written at the end of a run: a re-pointed run cut short left the old folder on record (the next run dropped the new folder's originals), and a first run cut short left rows with nothing pinned | fixed: the record is written before the first write; a re-pointed backup whose primary config root is not a directory is skipped, so no merge writes rows or originals the next run would drop | `harness-mirror.ts` `mirrorOne`; "S1: a first run records the folders before its first write", "S1: a re-pointed run cut short after its first write keeps the new folder's saved original", "S1: a re-pointed backup whose primary config folder is missing is skipped: …" |
| S2 | Dropping a re-pointed account's saved originals bypassed the save-time confirmation | fixed (Q2): a run that would drop records sets `overwrites` (`dropsRecords`), so the dialog and the CLI's `--yes` cover it | `harness-mirror.ts` `previewMirror`; "S2: a re-point that drops records asks for the confirmation even when nothing is overwritten; one with no records does not" |
| Account re-point confirmation (sibling of S2) | An account edit (`PATCH /harnesses/:id` changing `home` or `env`) that moved a backup away from its recorded folder made the next mirror drop that folder's records and saved originals with no confirmation (Q2) | fixed: the route answers 409 `mirror-records` (`HarnessEditMirrorRefusal`, with the folders and counts) unless the body carries `confirmMirrorDrop: true`; the prediction is `mirrorRecordsAffectedByEdit`, the same per-folder comparison `mirrorOne` makes (only a folder line the edit moves, never an edit back to the recorded settings, never an account with no rows or no recorded folder); a refused or invalid body applies nothing, `enabled` included. Settings asks with the core's sentence ("Save anyway") and re-sends; the CLI needs `harness edit … --yes`. Known narrow window, accepted: while an account's very first mirror run is still in flight the check sees no rows yet and does not ask. The claude death-during-hold status line now says the background agents were ended and a held card is released, which also fits a failed turn's card | `harness-mirror.ts` `mirrorRecordsAffectedByEdit`, `describeMirrorEditDrop`; `server.ts`; `src/mainview/lib/harness-edit-confirm.ts`, `SettingsDialog.tsx`; `src/cli/commands/harness.ts`, `usage.ts`; `claude-tmux.ts` `signalSessionDeath`. Tests: `server-harness-stacks.test.ts` "PATCH /harnesses/:id that would drop the account's mirror records"; `harness-mirror.test.ts` "an account edit that would drop its mirror records (mirrorRecordsAffectedByEdit)" (×6); `src/cli/harness-stack.test.ts` "harness edit: a mirror-records refusal is printed (escaped) and asks for --yes; …", "harness edit --yes sends the confirmation and saves", "harness edit --json prints a structured refusal"; `src/mainview/lib/harness-edit-confirm.test.ts` (×4); `claude-tmux-death.test.ts` (the death line) |
| S3 | Restore refused forever for an account that left its stack ("the next mirror of this account drops that record" was untrue: such an account is never mirrored again) | fixed: a gone recorded folder's rows and saved originals are dropped by Restore itself, with a message that says so; while the folder exists its rows are refused and kept | `harness-mirror.ts` `restoreOne`; "R-M2/S3: Restore drops records for a folder that is gone, says so, and never writes their originals here", "S3: Restore of an account that left its stack, whose recorded folder still exists elsewhere, refuses and keeps its records" |
| S4 | A planted orphan row with a column that is not its account's kind got past the liveness guard (the wrong root and shapes; a live Claude transcript could be unlinked); account delete had the same gap | fixed: `columnMatchesHarness` in `sweepOnce`, account delete and task cleanup; the store never lists an unknown column (`toOrphanedCopy`) and each sweep deletes such rows (`forgetForeignColumns`) | `harness-session-transfer.ts`, `db.ts`; `harness-session-transfer.test.ts` "orphan and handoff records whose column is not the account's kind (review S4)" (×4); `db-harness-stacks.test.ts` "a row under a column no handoff writes is never listed; forgetForeignColumns drops only those" |
| S5 | A scheduled switch erased itself before its move succeeded: a throw lost the failure line, and a crash booted into "run the task to switch" with the request gone | fixed: `beginManualAccountSwitch` carries `scheduledSwitch`; the final state write (or the boot completion of a moved row) consumes it; a throwing move drops it with "scheduled account switch failed: …"; a crash before the row moved boots into "it stays scheduled" and a retry | `orchestrator.ts` `beginManualAccountSwitch`, `moveTaskForSwitchNow`, `reconcileManualAccountSwitch`; "a scheduled switch survives until its move succeeds (S5)" (×3) |
| S6 | A successful handoff awaited the global sweep queue while holding the in-flight mark and the caller's start claim | fixed: the superseded session's sweep is fired after `heldTransfer` releases, not awaited; what it cannot remove is logged | `harness-session-transfer.ts` `heldTransfer`, `dropSupersededCopies`; "a successful re-key returns without waiting for the superseded session's sweep (review S6)" |
| S7 | An add's intent row had no hash: after a crash between the copy and the final row, a primary deletion or Restore kept the file forever | fixed: the intent row carries the hash of the source bytes about to be copied | `harness-mirror.ts` `mirrorFile`; "S7: a crash between an add's copy and its final row: a later primary deletion still removes the file", "S7: Restore right after such a crash removes the added file" |
| S8 | One unreadable sub-folder aborted the whole allowlist entry | fixed: a skip (its files left on the account), the rest mirrors and propagates, the payload counts as incomplete so a plugin registry is not rewritten; an unreadable top folder still fails the entry | `harness-mirror.ts` `planTree`, `copyEntry`; "S8: one unreadable sub-folder is a skip: …", "S8: a plugin payload with an unreadable sub-folder is incomplete: the registry is left untouched" |
| S9 | `persistence.md` did not say the 087 `harness_limit_state` rebuild is one-way | fixed (docs): a pre-087 build's `ON CONFLICT(harness_id)` upsert fails on a migrated database; a rollback is a new migration | `persistence.md` (087) |
| S10 | The Status row said "every finding fixed" although some items were owner decisions or accepted, and excused the `claude-tmux-askdrive` failures without a `main` baseline | fixed (docs): each round's outcome stated; the failures measured on `main` | this file, Status row |
| N1 | `releaseStartingClaim`'s microtask called `settleWaitingScheduledSwitch` unguarded | fixed: wrapped and logged like `endTurnSettle` | `orchestrator.ts`; "N1: a throw settling the switch on a claim release is logged, not left as an uncaught microtask error" |
| N2 | A Cancel sent while a scheduled switch was being applied answered `cancelled: false` and the CLI printed "nothing was scheduled" mid-move | fixed: `DELETE /tasks/:id/switch-account` answers 409 `busy` ("the switch is already under way") while `isAccountSwitchUnderway`; the CLI prints it and exits non-zero | `server.ts`, `switch-account.ts`; `server-harness-stacks.test.ts` "switch-account: a Cancel while the switch is being applied answers 409 busy and leaves the request alone (N2)", `harness-stack.test.ts` "switch-account --cancel while the switch is being applied prints the core's `busy` sentence, …" |
| N3 | A planted `created_at` (≥ 2^53, REAL, TEXT) froze `nextOrphanStamp` | fixed: seeded from integer stamps only, clamped to a day past the clock; `forget` without `notAfter` compares no stamp | `db.ts`; `db-harness-stacks.test.ts` "a planted created_at (…) does not freeze later stamps", "a seed far ahead of the clock is clamped to a day past it", "forget without a mark removes a record whatever its planted stamp (past 2^53, REAL, TEXT)" |
| N4 | `pauseOrphanSweepForTests` was taken by whichever queued sweep reached a removal first | fixed: keyed to `{harnessId, sessionId}`; `resetOrphanSweepPauseForTests` | `harness-session-transfer.ts`; "a sweep pause is keyed: a sweep of another account queued first never takes it (review N4)" |
| N5 | The round-2 N6 test covered only `viewAfterSave`; the `onSaved` wiring could regress green | fixed: `stackSavedHandler` extracted and tested | `SettingsDialog.tsx`; `SettingsDialog.test.ts` "stackSavedHandler (the StackEditor onSaved wiring)" (×2) |
| N6 | No test drove `endTurnSettle` applying a switch that became possible during the drain | fixed (test seam `__setScheduledSwitchHooksForTest`, `turnDrain`) | `orchestrator.ts`; "N6: background agents finishing during the follow-up drain: the settle's end applies the switch" |
| N7 | Removing the first top-level TOML key deleted the file's header comment | fixed: the header (the comment block set off by a blank line, `fileHeaderOf`) stays, in the merge and in Restore; a removed key's own comment goes with it | `harness-mirror.ts` `mergeCodexConfig`, `replaceTomlKey`; "N7: removing the first top-level key keeps the file's header comment; …", "N7: Restore removing the first top-level key keeps the file's header comment" |
| N8 | A file over 64 MB previewed as "update + backup" but the run failed in the backup store with a misleading message | fixed: an own copy over the backup limit is planned and run as the same skip | `harness-mirror.ts` `mirrorFile`, `MAX_BACKUP_BYTES`; "N8: an own copy over the backup limit is planned and run as the same skip, never as an update" |
| N9 | Restore left a merged file the mirror created as `{}` (or a comment-only TOML) | fixed: removed and listed in `removed` | `harness-mirror.ts` `restoreOne`; "N9: Restore removes a merged file the mirror created instead of leaving it empty; an account's own file stays" |
| N10 | `testing-seams.md` and `persistence.md` wording (`file-copied` reached by a dry run; the 089 "never edited" sentence) | fixed (docs) | `testing-seams.md`, `harness-stacks.md`, `persistence.md` |

Q1 on the other paths is pinned by `orchestrator-harness-switch-now.test.ts` "a FAILED turn's background agents are stopped and respected like a held task's (Q1)" (×6: Stop, Stop with an armed retry, archive, the death watch, a due retry, a manual prepare) and `server-harness-stacks.test.ts` "a FAILED turn whose background agents are still running refuses the switch exactly like a held one (Q1)" (PATCH) and "switch-account: a FAILED turn whose background agents still run is refused background-agents, like a held one (Q1)".

Docs updated for this round: `harness-stacks.md`, `harnesses.md`, `harness-claude-code.md` (the death watch during a hold and its status line), `persistence.md`, `security.md`, `run-panel.md`, `testing-seams.md`.

### Review round 4 (independent re-review of `f1a9eec7`)

A fresh read-only reviewer re-checked the round 3 fixes at `f1a9eec7` and found no must-fix, 4 should-fix (R4-1–R4-4; two introduced by round 3, two left open by it) and 6 nits (R4-N1–R4-N6). The orchestrator re-verified each should-fix in the code before the fix round; the owner asked to fix all. Each code fix has a regression test that the fixing agent reported red without the fix. Code is in the working tree after `9a269d97`; the final run is recorded in the Status row.

| ID | Finding | Outcome | Where fixed / regression test |
| --- | --- | --- | --- |
| R4-1 | `backgroundAgentsHoldTask` held ANY card with a running agent row and no live turn, so a stopped turn's background shell (card `ready`), or a card moved to `review`/`done`, refused "Switch to next account" and a same-stack PATCH (409 `background-agents`) and kept a scheduled switch waiting forever, on cards that offer no Stop | fixed: the failed-turn case of Q1 is exactly a `blocked` card whose current run `failed` (the cards that still offer a Stop); a running row on any other card holds nothing | `orchestrator.ts` `backgroundAgentsHoldTask`; `orchestrator-harness-switch-now.test.ts` describe "only a held card or a FAILED blocked one is held by its background agents (A1)"; `server-harness-stacks.test.ts` "a running agent row on a card whose turn was STOPPED (or that moved on) does not refuse the switch (A1)" |
| R4-2 | Restore deleted a merged file the account already had (an own `{}` JSON or comment-only `config.toml`): "every key row was an add" was taken to mean "the mirror created the file" | fixed: a created-file marker row (`scope` `file`, key `(created by the mirror)`, the hash of the text the mirror last wrote; no schema change) is written only when the mirror creates the file; Restore removes a file only with that marker, while the file still holds that text; rows from before the marker never remove a file | `harness-mirror.ts` `commitMerged`, `restoreOne`, `CREATED_FILE_KEY`; `harness-mirror-provenance.ts`; "B1: Restore keeps an account's own comment-only config.toml, comments included; …", "B1: Restore keeps an account's own {} settings.json", "B1: no marker (a row from before it), or a file the account rewrote, is never removed by Restore" and two marker-hygiene tests |
| R4-3 | The Codex `config.toml` header comment was still lost when the primary sets the backup's first key, and a comment-only top block was dropped when the primary adds keys (round 3 fixed only a removed first key) | fixed: the header (or a comment-only top block) belongs to the file and is lifted to the top whenever the first key does not stay first; the backup's own header wins; idempotent; Restore keeps it | `harness-mirror.ts` `mergeCodexConfig`, `replaceTomlKey`, `splitFileHeader`, `commentOnlyBlock`; three "B2: …" tests |
| R4-4 | An update's intent row (the one with `backup_ref`) hashed the account's original, so after a crash past the copy a primary deletion or a Restore before the next run kept the mirror's bytes as "edited" and never put the original back | fixed: the intent row carries the hash of the source bytes about to be copied (as round 3's S7 did for adds). Accepted narrow window: an update of a file the mirror already owns (no backup) writes no intent row; the next run heals a crash past its copy by adopting the equal file, but a primary deletion or Restore before that run keeps it as edited; closing it needs a second hash per row | `harness-mirror.ts` `mirrorFile`; "B3: a crash between an update's copy and its final row: Restore puts the original back", "B3: after such a crash the primary deletes the file: …" |
| R4-N1 | A Stop on a failed `blocked` card while a start (Retry, a codex floor probe) held the claim with no run minted interrupted the REPL and the start still launched | fixed: the Stop is recorded against the claim (`pendingCancelTaskIds`) and cancels the turn that start mints | `orchestrator.ts` `cancelRun`; `orchestrator-hold-scope-claim.test.ts` |
| R4-N2 | The background-agent API-error line said the "task releases when remaining agents finish" on a failed card too | fixed: the line holds for both cases | `claude-tmux.ts` `signalSubagentApiError`; `claude-tmux-subagent-apierror.test.ts` |
| R4-N3 | After a restart, a manual or PATCH intent that carried a scheduled request said "run the task to switch" while boot then applied the request | fixed: it says the scheduled switch stays scheduled | `orchestrator.ts` `reconcileManualAccountSwitch`; "a manual switch-now intent carrying a scheduled request says it stays scheduled, and boot applies it" |
| R4-N4 | A Cancel answered 409 `busy` during any account-switch claim, including a same-stack PATCH that never applies the request | fixed: `busy` only while the scheduled switch (or a "Switch to next account" move) is applied (`isScheduledSwitchUnderway`); otherwise the Cancel drops the request | `orchestrator.ts`, `server.ts`; `server-harness-stacks.test.ts` "a Cancel while another switch holds the claim (a same-stack PATCH) drops the request (A5)" and the reworked N2 test |
| R4-N5 | The account-edit 409 under-listed records when the core's environment had already moved a recorded folder | fixed: every recorded folder the edited account does not resolve to counts once the edit changes the root settings | `harness-mirror.ts` `mirrorRecordsAffectedByEdit`; "a recorded folder the account already disagrees with (the core's environment moved it) is listed once an edit changes the root settings: …" |
| R4-N6 | An unreadable sub-folder was reported twice (its own warning and the "skipped N entries" count); the N9 test could not catch R4-2 | fixed: counted once; R4-2's tests cover the account's own files | `harness-mirror.ts` `planTree`, `copyEntry`; "B5: an unreadable sub-folder is reported once, …" |

Docs updated for this round: `harness-stacks.md`, `harnesses.md`, `persistence.md`, `security.md`, `run-panel.md`, `testing-seams.md`.
