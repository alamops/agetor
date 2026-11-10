# Plan — Harness stacks fix round + improvements

| Field | Value |
| --- | --- |
| Date | 2026-11-09 |
| Source | Post-merge review of PR #295 (this session; the findings are restated in §4's finding map) + owner chat decisions + grill rounds 1–3 |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku) |
| Flags | none |
| Gates | grilled via decision form (`docs/plans/harness-stacks-fix-round-grill/round-1..3/answers.json`, all complete; every question answered by the owner) + plan approved by owner (chat, 2026-11-09) |
| Status | approved by owner; wave 0 in progress |
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
| D3 | **Follow-ups (items 3/4).** One helper stashes, to the backlog, every follow-up a handled ending leaves without a started successor: the Codex `codexTurnQueue`, undelivered mid-turn rows and `swapFollowUps`. A clean-retry arm persists `allExhausted.cleanRetryOf = oldRunId`. Its cancel, manual-message reset and cap paths recompute the unread follow-ups from `runs.mainUserTexts(cleanRetryOf)` (persisted, crash-safe) and stash them. | reasoning |
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
