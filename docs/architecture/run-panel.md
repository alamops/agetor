# RunPanel: one long-lived instance, per-task reset, connection budget

> Moved from `CLAUDE.md`, where this was the `RunPanel` bullet of “Things that will trip you up”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

`RunPanel` is ONE long-lived instance — `App.tsx` passes **no** `key` to it, and never has (the draft-persistence and open/close-animation machinery depend on the single instance).
Switching tasks is a prop change, so every per-task piece of `RunPanelBody` state must be reset in the `[task.id]` reset effect (`events`, `runs`, `runsLoaded`, `interactions`, `subagentList`, `sending`/`sendHint`, `backlogBusy`, `resolvingConflicts`, `rebuildBusy`, `resumeBusy`, `cancelAutoBusy`, `prStatus*`, `gitStatus`, search state, the stream-ready gate); two children that own their own per-task state are keyed instead (`<BacklogTray key={`backlog-${task.id}`}>`, `<TerminalsSection key={`terminals-${task.id}`}>`, the latter so `TerminalView` remounts and closes the previous task's terminal sockets).
Those keys are namespaced on purpose: both are siblings in the same `RunPanelBody` children list, sibling keys share one namespace, and React's keyed reconciliation keeps a single old fiber per key — when both carried a bare `key={task.id}` the tray's fiber shadowed the terminal section's, so every re-render on the reconciler's map-based slow path while the tray was mounted (any task with a saved draft; in practice every re-render, because the normally-`false` `{searchOpen && …}` child breaks the fast path) mounted a fresh `TerminalsSection` and never deleted the old one, stacking dozens of collapsed TERMINAL rows that each held a live `TerminalView`.
The invariant is broader than `task.id`: no two children of `RunPanelBody`'s fragment may share a key, so every keyed child there carries its component's name — `<PlanDialog key={`plan-${openPlan.id}`}>` is the third (`docs/plans/terminal-section-duplication.md`; regression test in `e2e/task-switch-during-restore.spec.ts`).
Adding new per-task state without a reset line here leaks it into the next task the user opens.
On a switch the panel opens the task's event stream (`openEventStream`, `/tasks/:id/events`) BEFORE its one-shot fetches, renders a `Loading messages…` skeleton (`data-testid="transcript-loading"`) until the first `listRuns` lands, and defers git-status / PR-mergeability until the stream's `replay_meta` frame (or 400 ms) — because WKWebView caps HTTP/1.1 connections per host at ~6 and two of them are permanent SSE channels, a burst of requests (or one long-held one) starves the stream; see `docs/plans/task-details-blank-while-session-restores.md`.
The 2 s polls (`listRuns`, `listSubagents` in the panel; `listTasks`, `refreshAgents` in `App.tsx`) skip a tick while their previous request is still in flight.
`RunsList` renders nothing until `runsLoaded` (no `No runs yet for this task.` flash while the first `listRuns` is in flight).
A dropped task stream reconnects with `Last-Event-ID` and resumes: the subscription drops frames at or below its highest accepted server id before the deduper; a `snapshotRequired` meta resets the subscription in the meta handler, before the fresh rows arrive (`buffer.discard()`, a new deduper and high-water mark, events / `loadedDbIdsRef` / `prevEventIdRef` cleared, `earliestId`/`hasMore` replaced rather than merged, the JSONL splice dropped and re-run through the `rebuildEpoch` dependency of the auto-rebuild effect, a muted `transcript-gap-notice` line)
— `nextEventIdRef` is deliberately NOT reset, so client ids stay monotonic for `rebuilt-mask.ts`; and every `replay_meta` after the first refetches pending interactions (merged by `src/mainview/lib/interaction-refetch.ts`, so a card that lands or resolves over SSE while the request is in flight isn't lost or revived) and kicks the runs/subagents polls, because `interaction`/`subagent` lifecycle frames are live-only and a drop misses them.

## Harness stacks

The task header shows the active account with its position (`2/3`; no
position for a stack of fewer than two accounts, which is inert), a
"Switching to …" line while `harnessState.pendingSwap` is set, and an
all-exhausted banner with a live countdown (reset on `task.id`) and a **Run
now** action. While the retry run itself is live (`allExhausted.inFlight` or
the card is `running`) the banner reads "Running on <account> after a quota
reset (attempt n/3)." and offers no Run now (`harnessStackBannerView`,
`src/mainview/lib/harness-stack-banner.ts`). A same-kind account switch in the
account picker PATCHes only `{ agent }`, so mode, model, effort, speed and Max
mode survive; a cross-kind switch resets them to the kind defaults
(`agentSwitchPatch`). In sticky-user-message mode the hidden continuation does
not open a section. A `status`
event with the `harness-swap:` prefix renders as a divider carrying the exact
notice plus `(2/3)`; a `user` event that is exactly the hidden
`<harness-stack-continuation>` wrapper renders nothing. The panel takes an
optional `stacks` prop; no extra fetch is made. See
[harness-stacks.md](harness-stacks.md).

## Multiple repositories in one task

A task created against two or more repositories stores `Task.repositories[]` and runs at a per-task workspace root with one linked worktree per repository; the feature is [multi-repo-tasks.md](multi-repo-tasks.md). A single-repository task's panel is unchanged.

The repository tabs at the top of the panel select the active entry; the header "View PR" link, mergeability/Resolve Conflicts, the PR head and the terminal cwd all follow that entry (`task.prUrl` stays null for a multi task). New terminals default to the workspace root (where the agent runs and sees every repository); the terminal section's own selector — and the repository tab — can point the next shell at one repository's worktree instead (existing tabs keep their cwd). "Create all PRs" only walks entries without a `prUrl` that are pushed/synced, using each repository's live checkout as the PR head (drift is tolerated, never corrected), so a retry after a partial failure never duplicates a PR.

Per-task state the multi surfaces add, and how each survives a task switch:

- **Repository tab** (`repoTab`) is local state with a reset line (`setRepoTab(null)`) in the `[task.id]` reset effect.
- **"Create all PRs" in flight** is deliberately *not* panel state, so it has no reset line: it is a module store in `src/mainview/lib/multi-repo-ui.ts` keyed by task id (`beginPrBatch`/`endPrBatch`, read through `useSyncExternalStore(subscribePrBatches, …)`). A switch away and back still shows the walk running for that task, and a second press while one runs does nothing. The store also remembers which repositories a walk opened a PR for (`markRepositoryPrOpened`), and `repositoriesForPrBatch` leaves those out until the board poll delivers their `prUrl`, so a press right after a walk can't re-target them (GitHub's 422 would show as a failure). After the walk the panel fetches the task and merges its `repositories` (`onTaskFieldsChanged`, by id, safe after a switch) so the PR links update without waiting for the 2 s poll.
- **"Resolve Conflicts — Sent to agent"** is keyed by repository tab: `resolveConflictsSentKey` holds `resolveConflictsKey(multiRepo, activeRepo)` (`repo:<name>`, or `""` for a single task), the confirmation and its lockout apply only while that same key is showing, and the reset effect sets it to `null`.
- **Open folder.** A never-started multi task has no workspace on disk (`worktreePath` is null), so the working-folder button explains that instead of opening (`openFolderUnavailableReason`).
- **Connection budget.** The multi-repository `@` listing and capability discovery are one request per repository, at most two in flight, and both wait for this task's event stream (`awaitStreamReady(task.id)`, bound to the task id like `TerminalsSection`'s gate) so a switch never queues the stream behind them. The git-status poll stays one batched request for every repository.
- **Terminals.** With no repository tab chosen (`repoTab` is null after a switch) a new terminal opens at the workspace root (owner decision, grill #19); choosing a tab, or the terminal section's own selector, points the next shell at that repository's checkout.

