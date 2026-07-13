# Plan — Claude Code to-do list progress in the task details panel

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Source | `/implement we must support claude code to-do list and showing the progress in the task details modal` + reference screenshot |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `agetor/49082f8f97dd-add-claude-code-to-do-list-support` (pre-existing) |
| Base SHA | `833529b837989cf11a8ff141049d14fdd3b3835f` |

## 1. Objective & success criteria

Surface Claude Code's `TodoWrite` to-do list as a **persistent, live-updating progress card pinned at the top of the task details panel** (the `RunPanel` slide-over), so the user can see plan progress at a glance without scrolling the conversation.

**Done means:**
- While a claude-code task has an active to-do list, a card sits above the event log showing every todo with its state (✓ completed / ■ in-progress / □ pending) and an `N/M` done counter.
- The card updates live as Claude re-emits the list (latest snapshot wins).
- The card follows the active stream tab (main run or a background/subagent tab).
- The card is absent when the task has no to-dos.
- Existing inline `TodoWrite` cards in the conversation stream are **unchanged** (kept as history).
- `bun run typecheck` is green; new unit tests for the derivation logic pass under `bun test`.

**Non-goals (explicitly out of scope):**
- Elapsed-time timer and token count in the card header (user chose checklist + `N/M` only).
- Any new `RunEventStream` type, DB migration, or backend change.
- Codex `todo_list` parity (`codex-tmux.ts:189` currently falls through to a generic `tool_use`).

## 2. Context & constraints (grounded findings)

- **`TodoWrite` already flows end-to-end as a generic `tool_use`.** The JSONL mapper has no per-tool special-casing: `src/bun/claude-tmux.ts:585-593` emits `onChunk("tool_use", JSON.stringify({ id, name, input, serverSide }), uuid)`. So `input.todos` is already on the wire and already persisted in `run_events`.
- **The webview already renders it** — per snapshot, inline: `src/mainview/components/kanban/RunPanel.tsx:2232-2247` maps `input.todos` to a `<ul>` with `✓ / → / ○`. Because Claude re-emits the **full list on every change** (each JSONL line with a distinct `uuid`, so nothing dedupes), the stream accumulates **one card per snapshot**. That is the actual problem: the current state is buried in scrollback.
- **Therefore no backend work is required.** The correct fix is a client-side **latest-wins derivation** over the events the panel already holds. Both investigation agents converged on this independently.
- **Panel structure:** the "task details modal" is a right-hand `<aside>` slide-over (`RunPanel.tsx:170`), not a Dialog. `RunPanelBody` renders, top to bottom: `<header>` (`:860`), `<FileMentions>` (`:921`), `<TaskDetails>` (`:927`), `<RunsList>` (`:936`), `<TerminalsSection>` (`:938`), `<SubagentTabs>` (`:940-949`), the event scroll region (`:951-999`), then the composer (`:1009`).
- **Derived state convention:** `mainEvents` (`:521`), `subagentEventsById` (`:524`), `displayedEvents` (`:539-544`) are sibling `useMemo`s. `displayedEvents` already resolves the active tab (main, with a JSONL-rebuild splice; or a subagent's transcript). A new `todoProgress` memo belongs right after it.
- **`RunPanel` does not remount on task switch** — there is *no* `key={selected.id}` in `App.tsx:638-649`; state is reset via effect (`RunPanel.tsx:263-275`). Derived memos are safe regardless.
- **Testing convention:** the webview has **no DOM test harness**. Pure logic is extracted into `src/mainview/lib/*.ts` and unit-tested with `bun test` — exactly as `lib/subagent-tabs.ts` was (see the comment at `RunPanel.tsx:576-578`). This dictates the file split below.
- **Gating:** interactive elements must gate on `activeStream === "main"` (subagent tabs are read-only). The todo card is **display-only**, so it needs no gate and can safely render on every tab.
- **Styling idiom:** hand-rolled Tailwind, `text-[11px]`, `rounded-md border border-border/60 bg-card`, `cn()` from `@/lib/utils`. `lucide-react` is available and `ListTodo` is already imported (`RunPanel.tsx:7`). No `Progress`/`Checkbox` primitive exists — hand-roll.

## 3. Approach & key decisions

**Chosen:** derive the current to-do list on the client from the existing `tool_use` event stream; render it in a new pinned presentational component.

Alternatives considered and rejected:
- *New `todo` `RunEventStream` + UPSERT-latest persistence.* Would require a `RunEventStream` union change, a new `db.appendEvent` upsert path, and possibly a migration — and would break the append-only `INSERT OR IGNORE` idempotency that reattach/replay depends on (`db.ts:573`, migration `022:24-25`). All cost, no benefit: the data already reaches the client.
- *Collapse duplicate snapshots in the stream in place.* Rejected by the user — inline cards stay as history.

**Assumptions logged** (defaults I chose; flag if wrong):
- A latest snapshot with an **empty** `todos` array renders nothing (Claude clears the list this way).
- The card's title uses the `activeForm` of the in-progress todo (e.g. *"Building the Move-to-Trash modal…"*), falling back to `"To-dos"`. This is free — `activeForm` is on the same todo object — and matches the screenshot's spirit without needing timers or token counts.
- Long lists get `max-h-48 overflow-y-auto` so a 20-item plan can't eat the 520px panel.
- Unknown/missing `status` values coerce to `"pending"`; malformed todo entries are skipped rather than crashing the panel.

## 4. Work breakdown — implementation tasks

**T1 — `src/mainview/lib/todo-progress.ts`** *(owns this file only)*
Pure, DOM-free derivation + types. Exports exactly:

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { content: string; status: TodoStatus; activeForm?: string }
export interface TodoProgress {
  todos: TodoItem[];
  completed: number;   // count of status === "completed"
  total: number;       // todos.length
  activeForm: string | null;  // activeForm of the first in_progress todo, else null
}
export function deriveTodoProgress(events: RunEvent[]): TodoProgress | null;
```

Behavior: scan `events` in order; for each `e.stream === "tool_use"`, JSON-parse `e.data`, keep the **last** one whose `name === "TodoWrite"` and whose `input.todos` is a non-empty array. Return `null` when there is no such event. Never throw on malformed JSON or malformed todo entries.
Acceptance: typechecks; no React/DOM import; handles the cases enumerated in T4.

**T2 — `src/mainview/components/kanban/TodoProgressCard.tsx`** *(owns this file only)*
Presentational component, props `{ progress: TodoProgress }`. Bordered card matching the panel idiom: header row with the `ListTodo` lucide icon, title = `progress.activeForm ?? "To-dos"`, right-aligned `{completed}/{total}` counter. Body `<ul>`: `✓` + muted line-through for completed, a filled marker + medium weight for `in_progress`, `□` muted for pending. `max-h-48 overflow-y-auto`. Imports its types from `@/lib/todo-progress` (T1's contract above — write against it verbatim; the file lands in the same wave).
Acceptance: typechecks; no data fetching, no state, no interactivity.

**T3 — wire into `src/mainview/components/kanban/RunPanel.tsx`** *(owns this file only; wave 2)*
1. Import `deriveTodoProgress` from `@/lib/todo-progress` and `TodoProgressCard`.
2. Add a sibling memo immediately after `displayedEvents` (after `:544`):
   `const todoProgress = useMemo(() => deriveTodoProgress(displayedEvents), [displayedEvents]);`
3. Render `{todoProgress && <TodoProgressCard progress={todoProgress} />}` **between** the `SubagentTabs` block (ends `:949`) and the event scroll region (`<div ref={logRef}>`, `:951`) — so it visually belongs to the selected tab.
Do **not** modify the inline `TodoWrite` renderer at `:2232-2247`, and do not touch any other behavior.
Acceptance: `bun run typecheck` green; card appears above the log, follows the active tab.

## 5. Work breakdown — test tasks

**T4 — `src/mainview/lib/todo-progress.test.ts`** *(owns this file only)* — covers T1:
no events → `null`; no `TodoWrite` among other `tool_use` events → `null`; single snapshot parsed correctly; **multiple snapshots → latest wins**; malformed `data` JSON skipped, not thrown; empty `todos` array → `null`; `activeForm` taken from the `in_progress` todo and `null` when none is in progress; `completed`/`total` counts; unknown `status` coerced to `"pending"`; non-`tool_use` streams ignored.

No test is written for T2/T3 — the webview has no DOM harness (repo convention).

## 6. Execution waves

- **Wave 1 (parallel, file-disjoint):** T1, T2.
- **Barrier.** Typecheck.
- **Wave 2:** T3.
- **Phase 5:** code review of `git diff 833529b...HEAD`.
- **Phase 6:** T4. **Phase 7:** `bun test` + `bun run typecheck`.

## 7. Blast radius & risks

- **Low.** Three new/changed files, all webview-side. No backend, DB, migration, IPC, or shared-type change; no change to what is persisted or streamed.
- `RunPanel.tsx` is the only existing file touched, and only additively (import + one memo + one conditional render). The inline `TodoWrite` renderer is untouched, so the stream's history rendering cannot regress.
- **Watch:** `displayedEvents` is recomputed on every SSE frame; `deriveTodoProgress` is an O(n) scan over the full event array. For very long conversations this runs per frame. The existing `mainEvents`/`subagentEventsById` memos already do full O(n) scans on the same dep, so this adds a constant factor, not a new complexity class. Prior art warns about O(N²) sidebar lag (peer entry `aaa626c8`) — keep the scan single-pass and memoized on `displayedEvents` alone.
- **Rollback:** delete the two new files and revert the three-line `RunPanel.tsx` edit.

## 8. Open questions / assumptions

Resolved with the owner in Phase 2:
- Placement → **pinned card at top** of the panel, above the log.
- Header stats → **checklist + `N/M` done only**; no elapsed timer, no token count.
- Inline `TodoWrite` cards → **kept as history**, unchanged.
- Stream scope → **follows the active tab** (`displayedEvents`), main and subagent alike.

Assumed by me (see §3): empty-list → render nothing; `activeForm` as the card title; `max-h-48` scroll; unknown status → `pending`.

Deferred: codex `todo_list` parity; token/elapsed header stats.
