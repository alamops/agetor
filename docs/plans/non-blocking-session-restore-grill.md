# Grill — Non-blocking session restore (sending to a long-idle task freezes every other task and pipeline)

| Field | Value |
| --- | --- |
| Date | 2026-10-14 |
| Source | `docs/plans/non-blocking-session-restore-investigation.md` (pipeline step "Investigation") + task screenshot `screenshot-2026-10-14_23-22-41-77269c58.png` |
| Mode | interactive, answered by the owner (alamops) in four `AskUserQuestion` passes |
| Flags | none |
| Branch | `fix/fix-agetor-blocking-after-restoring-idle` |

## 0. New evidence gathered during the grill (changes the investigation's recommendation)

All read-only against `~/.agetor/agetor.sqlite` (4.56 GB); spikes in the session scratchpad (`spikes/task-scoped-seed/spike.ts`, `read.ts`).

- **A task-scoped query hits the EXISTING unique index — no migration needed.** `SELECT e.line_uuid FROM runs r JOIN run_events e ON e.run_id = r.id WHERE r.task_id = ? AND IFNULL(e.subagent_id,'') = ? AND e.line_uuid IS NOT NULL` → `SEARCH r USING INDEX idx_runs_task` + `SEARCH e USING COVERING INDEX run_events_run_sub_line_uuid (run_id=? AND <expr>=? AND line_uuid>?)`. The expression must be spelled exactly `IFNULL(subagent_id, '')` for the planner to use the index (`migrations/022_subagents.sql`).
  - One subagent: 51 ms total wall (process start included) vs **11.2 s cold** for today's `WHERE subagent_id = ?` (same 155 rows).
  - Whole rehydrate seed in `bun:sqlite`, seed + monitor-prefix probe per subagent: 208-subagent / 250-run task **195.8 ms** (worst call 10.3 ms); 140-subagent task 75.6 ms; 109-subagent task 49.6 ms. Today that 208-subagent task costs ~230 s.
- **Semantics are preserved on all production data.** Of 466,609 subagent events with a `line_uuid`: 0 sit under a run of a different task than their `subagents` row, 0 are orphaned (no `subagents` row), 0 use `subagent_id = ''`, 0 `subagents` rows have `run_id NULL`, and 0 events sit under a run other than their row's own `run_id`. `subagents.id` is a global PRIMARY KEY, so a subagent belongs to exactly one task. Task scoping is a strict superset of run scoping, so it also covers a future subagent that spans runs.
- **A second stall sits behind the query, in the watcher's first cycle.** `cycle()` with `tailAll = firstCycle` (`claude-subagents.ts:3709`) re-reads every subagent transcript synchronously on the first `tick`. For the biggest task that means 192 files / 596 MB / 129,847 lines, and read + `JSON.parse` alone takes **1.29–1.55 s**. The worst single file is 32 ms, so yielding between files restores responsiveness. Task #2: 120 files / 299 MB.
- **Retention numbers.** Archived tasks account for 76% of `run_events.data`, in their `tool_result` payloads: 2,294.5 MB main stream + 632.5 MB subagent streams. Archived assistant/user/status/thinking total about 80 MB. Trimming archived `tool_result` payloads to 4 KB frees about 2.45 GB. By archive age (total MB / trim-reclaimable MB): <7 d 350 / 189 · 7–30 d 705 / 596 · 30–90 d 2,081 / 1,612 · >90 d 122 / 50.
- **For most archived history, agetor's DB is the only copy left.** 4,409 of 5,285 archived subagent transcripts (83%) are already gone from disk (Claude Code's own cleanup; `cleanupPeriodDays` isn't set, so the default applies).
- **Compaction cost.** `VACUUM INTO` of today's 4.2 GB file took **30.8 s**. After the trim, expect roughly half. bun:sqlite is synchronous, so a VACUUM blocks the whole core for its full duration.
- No other data-dir folder carries event history: `worktrees` (56 GB) holds live checkouts and `harnesses` (1.7 GB) holds account homes; `screenshots` 108 MB; the per-harness log dirs are each under 3 MB.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Data & contracts | How should we fix the slow subagent query? | **Task-scoped rewrite through the existing `run_events_run_sub_line_uuid` index: no migration, no new index.** Applies to `seenLineUuidsForSubagent` and `hasLineUuidPrefixForSubagent`; both gain a `taskId` parameter (available at every call site: `row.taskId` / the watcher's `taskId`). | owner; evidence §0 |
| 2 | Non-functional | Should the rehydrate seed and the first-cycle transcript replay yield to the event loop? | **Yes — yield between rows/files in ~20 ms slices.** Order is unchanged: seed, then tail, then the `ready` status line. Dedupe semantics are unchanged. Applies to resume, fresh spawn, boot reattach and the held-task re-arm. The comment at `claude-subagents.ts:~1740` ("runs synchronously inside reattachSession/the spawn IIFE") and every caller relying on that synchronicity must be audited and updated. | owner |
| 3 | Acceptance | What is the bar? | **No single main-thread block over 100 ms** during resume, fresh start or boot reattach, **and `ready` within 2 s of the spawn**, for a task like the owner's 208-subagent / 596 MB one on a DB that size. Other panels, the board and pipelines answer in normal time throughout. | owner |
| 4 | Acceptance | Which regression guards? | **All three.** (1) A guard test: `EXPLAIN QUERY PLAN` for every `run_events` query in `db.ts` must show `SEARCH`, never a full-table/full-index `SCAN`. (2) Integration test: seed ~500k events plus many subagent transcripts, attach the real watcher, and assert max timer drift stays under the bar (generous margin per the repo's flake-class rule). (3) A fake-driver seam that attaches the **real** subagent watcher over seeded transcript files, plus an e2e test (extending `e2e/task-switch-during-restore.spec.ts`) where another task's panel, the board and a pipeline view load during that restore. | owner |
| 5 | Observability | Event-loop-lag monitor? | **Yes, monitor plus task breadcrumb.** An unref'd 500 ms timer. A stall of 1 s or more logs one `console.warn` naming the last labelled operation (e.g. `attach subagent watcher · task X`). When the label names a task, it also adds a `core was unresponsive for N s during …` status line to that task's run. Labels go on the attach/seed/replay paths (and the retention pass). | owner |
| 6 | States (client) | Should the webview signal a busy core? | **App-level busy banner; requests aren't aborted.** When any request has been pending over 3 s, the client probes `/health`. If that also fails within 1.5 s, it shows an "Agetor core is busy — waiting…" banner, cleared once the core answers. Mutations stay `retry: false`; no GET is aborted. | owner |
| 7 | Contracts | Bound the remaining pre-dispatch holds on `POST /runs/:id/input`? | **Yes, bound the whole pre-dispatch.** The 1.5 s `SPAWN_RESPONSE_BUDGET_MS` race starts at the top of `sendInput` and covers `pendingTeardown`, the worktree restore, the codex CLI-version floor, `@`-expansion and the liveness probe, as well as the spawn. Past the budget it answers `pending: true` and continues in the background. | owner |
| 8 | Acceptance | Verify on real data? | **Yes, on a copy with a headless attach.** Copy the prod DB into `~/.agetor-dev` with `sqlite3 .backup` (never `cp`), run the real seed and first pass against the copy and the real transcripts with no claude launch, and record max block time and total time in the plan. Nothing outside `~/.agetor-dev` is written. | owner |
| 9 | Scope | Prune events of archived tasks? | **In this change** (see R1–R5). | owner |
| 10 | Scope | Should `AGETOR_TRACK_SUBAGENTS` become a Settings toggle? | **No; it stays an env var.** | owner |
| D1 | Scope | Boot | Boot is in scope. The rewrite and the yielding also cover `reconcileOrphans` → `reattachSession` and the held-task re-arm (`orchestrator.ts:987`, `:1020`). | owner-confirmed default |
| D2 | Scope | Call sites | Both queries are rewritten at every call site: `claude-subagents.ts:1908` (seed), `:1841` (rehydrate, monitor rows), `:1421` (per monitor event on a `completed` row). | owner-confirmed default |
| D3 | States | Panel line | `No runs yet for this task.` (`RunPanel.tsx:4931`) waits for `runsLoaded`, like the transcript does. | owner-confirmed default |
| D4 | Observability | Launch breadcrumb | The watcher seed and first pass become a timed stage in the existing `session launch took Ns (kill … · settings … · tmux new-session … · watcher …)` breadcrumb. | owner-confirmed default |
| D5 | Observability | Monitor settings | Threshold 1 s, sampled every 500 ms, one line per stall. Off under `bun test` unless a test turns it on (env seam), so it can't add events to other tests' assertions. | owner-confirmed default |
| D6 | States | Failure after `pending: true` | A refusal that needs no await (archived task, harness unavailable, validation) still answers synchronously. A pre-dispatch failure after `pending: true` (worktree restore, codex version floor, liveness) re-stashes the message into the backlog (deduped, archived-guarded, as withheld sends are) and shows a toast through a global event, because no run row exists yet to hold a status line. A second send in that window is declined by the existing `startingTaskIds` claim. | owner-confirmed default |
| D7 | Scope | Banner placement / CLI | One app-level banner. The CLI and TUI get no change (they already have request timeouts) beyond what the core fix gives them. The CLI must keep tolerating `pending: true` on `send`/`start`. | owner-confirmed default |
| D8 | Scope | Pipelines | No pipeline-specific code. The run view and step launches recover through the same core fix, since a step launch is a claude spawn. | owner-confirmed default |
| D9 | Non-functional | Yield details | Slices of about 20 ms. Order seed → tail → `ready`; the in-memory `seen` sets and the DB unique index keep today's dedupe semantics. | owner-confirmed default |
| D10 | Docs | Docs | Update `CLAUDE.md` (boot reconciliation / `seenLineUuids` paragraphs, Persistence section, a retention paragraph, the busy banner, the lag monitor) and add a pointer in `docs/plans/task-details-blank-while-session-restores.md` §2 / §8 Q1 saying the core-stall case is now answered. | owner-confirmed default |
| D11 | Rollout | Real-data copy | Copy via `sqlite3 ~/.agetor/agetor.sqlite ".backup …"` (safe while the app is running). No writes to `~/.agetor`. | owner-confirmed default |
| R1 | Retention | What is removed? | **Trim big tool results.** Every row stays. `tool_result` payloads over 4 KB are cut to their first 4 KB plus a marker. Prompts, replies, tool names and plans stay readable. | owner |
| R2 | Retention | Age threshold | **Archived for 30 days or more** (frees about 1.66 GB today). | owner |
| R3 | Retention | Trigger / control | **Automatic plus a Settings control.** Runs after boot (once the API is up) and then daily, in yielding batches. Settings → General gets an "Archived task history" control (days, or Off), also settable via `agetor config`. | owner |
| R4 | Retention | Compaction | **Manual "Compact database" button.** Settings shows DB size and reclaimable space; the button runs VACUUM behind a blocking "Compacting… ~N s" modal. Never automatic. | owner |
| R5 | Retention | Compact while runs are active | **Refused** while any run is active, in the app and the CLI alike ("N tasks running — stop or wait for them first"). A held turn's idle timer could otherwise fire before its tailer catches up, once the core resumes. | owner |
| RD1 | Retention | Scope | Archived tasks only; live tasks are never touched (task delete already cascades). | owner-confirmed default |
| RD2 | Retention | Trim mechanics | Only the output text field of the stored payload is cut, and the JSON stays valid. Structured fields (`is_error`, `attachments`, tool ids) and `line_uuid` are kept, so unarchive + resume never re-imports. A muted "trimmed by retention (original N KB)" note renders in RunPanel, `agetor logs` and the TUI. | owner-confirmed default |
| RD3 | Retention | Execution | ~20 ms batches with yields (same 100 ms bar), never one big transaction. Idempotent (already-trimmed rows skipped); after a crash it picks up where it left off. | owner-confirmed default |
| RD4 | Retention | Reversibility | One-way. Unarchive works, but trimmed rows aren't restored. "Rebuild from session JSONL" recovers only where Claude's transcript still exists. | owner-confirmed default |
| RD5 | Retention | Derived data | Unaffected: plans, sent files, TODO progress and pipeline handoffs live in task columns. | owner-confirmed default |
| RD6 | Retention | Setting | Preference `archivedHistoryRetentionDays` (default 30, plus Off). Changing it schedules a pass shortly after. | owner-confirmed default |
| RD7 | Retention | Feedback | No toast for automatic passes. Settings shows "last trimmed <date>, freed N MB", and the core logs one console line. | owner-confirmed default |
| RD8 | Retention | Settings display | DB file size and reclaimable space, from `PRAGMA page_count` / `freelist_count` × `page_size`. | owner-confirmed default |
| RD9 | Retention | CLI parity | `agetor config` for the setting; `agetor compact` (stats, confirm prompt, same refusal rule as R5). | owner-confirmed default |
| RD10 | Retention | First pass after upgrade | Trims about 1.66 GB in yielding batches. It may take minutes in total but never blocks over 100 ms; the lag monitor verifies. | owner-confirmed default |
| RD11 | Retention | Tests | Unit tests for trimming (JSON shape kept, idempotent, archived only, age gate), an integration drift test during a pass, and an e2e test that a trimmed result renders its note. | owner-confirmed default |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Rewrite `seenLineUuidsForSubagent` + `hasLineUuidPrefixForSubagent` and all three call sites | in this change | owner (#1, D2) |
| Yield in the rehydrate seed and the first-cycle replay; audit synchronicity assumptions | in this change | owner (#2, D9) |
| Boot reattach + held-task re-arm | in this change | owner (D1) |
| Event-loop-lag monitor + task breadcrumb + `watcher` stage in the launch breadcrumb | in this change | owner (#5, D4, D5) |
| Busy banner in the webview | in this change | owner (#6) |
| `RunPanel.tsx:4931` "No runs yet" gate | in this change | owner (D3) |
| Bound all of `sendInput`'s pre-dispatch with `pending: true` + backlog/toast failure path | in this change | owner (#7, D6) |
| Plan guard test over every `run_events` query, drift integration test, real-watcher fake-driver seam + e2e | in this change | owner (#4) |
| Headless attach measurement on a copy of the prod DB | in this change | owner (#8, D11) |
| Archived-history retention (trim, 30 d, auto + setting, CLI), Compact button + `agetor compact` + refusal gate | in this change | owner (#9, R1–R5, RD1–RD11) |
| Docs: `CLAUDE.md`, #230 plan pointer | in this change | owner (D10) |
| New partial index on `run_events(subagent_id, line_uuid)` | out of scope | owner chose the rewrite (#1); the existing index already serves the task-scoped shape |
| Settings toggle for `AGETOR_TRACK_SUBAGENTS` | out of scope | owner (#10): the fix removes the need, and turning it off drops background-agent tabs |
| Per-request GET timeouts / aborts in the webview | out of scope | owner chose banner-only (#6) |
| Skipping replay of settled subagents via a stored per-file offset | out of scope | owner chose yield-only (#2); would need a new column + migration |
| Automatic VACUUM | out of scope | owner chose manual compaction (R4) |
| Real claude resume in a dev build against the copy | out of scope | owner (#8): it would append to a real conversation and spend quota |
| Retention for non-archived tasks, the screenshots dir, worktrees | out of scope | different tickets; not event history (worktrees are live checkouts; screenshots 108 MB) |
| Deleting or trimming `tool_use` inputs | out of scope | owner chose trimming `tool_result` only (R1) |

## Assumptions still open (the planner must resolve these from code, not the owner)

- **Stored `tool_result` shapes differ per harness.** claude, codex, cursor, gemini, antigravity and fx each map their tool output into `run_events.data`; the trim must locate the output text field in each shape without breaking `JSON.parse` or the client renderers (`ToolResultBlock`, `SentFilesCard`, TODO tracker, `event-search`). If one shape has no separable text field, the plan must fall back to a safe whole-payload replacement for that shape only.
- **Callers that rely on synchronous rehydration.** The spawn IIFE (`claude-tmux.ts:8475`), `reattachSession` (`:~8575`), `reconcileOrphans`'s seeding (`orchestrator.ts:823–861`) and the held-task re-arm assume `attachSubagentWatcher` returns with `files` populated. Making it async may reorder boot reconciliation or the `ready` line. The plan must keep `ready` after the seed and prove no settle/reattach race (e.g. a subagent settle arriving mid-seed).
- **Duration of the first retention pass on the owner's DB** (~700k candidate rows / ~1.66 GB) is unmeasured. Measure it in the headless copy run (#8) alongside the attach numbers.
- **Post-trim VACUUM ≈ 15 s** is extrapolated from the measured 30.8 s at today's size. The Compact modal's "~N s" must estimate from page counts, not a constant.
- **The banner can misattribute.** A `/health` probe failing under WKWebView's ~6-connection cap looks the same as a frozen core. The banner copy should stay neutral ("Agetor is busy — waiting for the core…").
- **The 100 ms / 2 s bar holds on the owner's SSD.** CI and test machines may be slower, so test thresholds keep a structural margin (the failure mode is seconds, not "a bit slow").
- **The lag monitor's `console.warn`** lands in Electrobun's stdout in the packaged app; the user-visible signal is the transcript status line, which only exists when the label names a task.
