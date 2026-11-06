# Messages backlog (saved draft messages) and compose-from-diff

> Moved from `CLAUDE.md`, where this was orchestration-flow item 7. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

**Messages backlog** (saved, not-yet-sent draft messages per task): `task.backlog` is a `BacklogMessage[]` (`{ id, text, references, createdAt }`) persisted as a JSON column on `tasks` (migration 025), mirroring the `refs` column end-to-end (`parseBacklog` in `db.ts` sanitizes on read; `insert`/`update` stringify).
The `backlog` module in `db.ts` (add/updateItem/remove/reorder) is pure list transforms over `tasks.update` — no process side effect, so `server.ts` calls it directly (no orchestrator).
Routes: `POST /tasks/:id/backlog` (add), `PUT /tasks/:id/backlog` (reorder — `{ order: string[] }`; PUT on the collection avoids colliding with the member route), `PATCH|DELETE /tasks/:id/backlog/:itemId`.
Every mutation returns the full updated `Task` and is rejected on an archived task (`backlogGuard`), matching the task-PATCH freeze.
In the RunPanel, "Save for later" stashes the composer's text+refs; each tray item can be sent (reuses `sendRunInput` then consumes the item), edited inline, deleted, or reordered (↑↓).

**Composing is decoupled from sending**: the composer textarea + refs picker + "Save for later" stay enabled in the two states you *can't* send from — before the task's first run, and while a native prompt is pending — since those are exactly when you most want to jot something down.
Only *sending* is gated: the Send button is disabled on `!canSend`/`modalPending`, and `send()` itself early-returns on `!resumableRunId` and on `modalPending` (that second guard is load-bearing — a keystroke reaching a live tmux modal would paste into the prompt instead of the agent; for fx, whose turn is parked awaiting the ACP permission reply rather than a tmux modal, the same guard keeps a follow-up from doing anything more useful than queuing behind the still-unanswered card).
Enter is never a dead key: in a non-sendable state it routes to "Save for later" instead.
The tray is hidden on background-agent (subagent) tabs — those streams are read-only — and on an **archived** task it renders `readOnly` (drafts visible, every mutation affordance stripped), matching the server-side archived freeze rather than hiding the drafts entirely.

**Collapsible tray.** The tray header is a disclosure `<button>` (`data-testid="backlog-toggle"`). It starts expanded; collapsing unmounts the draft list (`data-testid="backlog-list"`), keeps the icon, label and count, swaps the hint to `saved messages — expand to review`, and hands the freed height back to the transcript. Collapse is blocked while a row is inline-editing (the hint asks to save or cancel first), so no unsaved edit is discarded. The state is session-only — `BacklogTray`'s local state, reset on task switch, subagent tab, panel close, and when the tray empties (the next saved draft opens expanded). Archived tasks keep the toggle; the expanded hint stays the read-only one.

**Compose-from-diff**: `DiffDialog` lets you click (and shift-click-extend, across multiple files) diff lines into a selection, which surfaces an inline composer — `groupSelectedRows`/`composeDiffMessage` in `lib/diff-selection.ts` turn the selected rows into a labeled fenced snippet appended to your typed message.
The composer mirrors RunPanel's gating exactly (`resumableRunId`, `modalPending`, a pre-send re-check of pending interactions) and offers the same two exits: send now via `sendRunInput`, or stash via `addBacklogItem`.
