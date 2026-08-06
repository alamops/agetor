# Plan — Selectable diff lines → compose message to agent (send now or save to backlog)

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement invocation (agetor task prompt) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/git-diff-to-message |
| Base SHA | 3f4b057e826383869fff20bf118f7c33b0072d0f |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (owner unreachable); all assumptions logged in §8 |

## 1. Objective & success criteria

In the task git-diff dialog (`DiffDialog.tsx`), let the user click one diff line or select multiple, type a message about them, and either **send it directly to the running agent** or **save it into the task's messages backlog**. Success:

- Diff lines (add/del/context — not hunk headers or meta rows) are click-selectable; shift-click extends a range within a file; selections may span multiple files.
- With a non-empty selection, an inline composer appears in the dialog with a textarea + **Send to agent** + **Save for later** + **Clear selection**.
- Send delivers `userText + quoted diff snippets` via the existing `POST /runs/:id/input` path; Save creates a backlog item whose `text` is the same composed string (references untouched). Both are indistinguishable downstream from a hand-typed message.
- Send is gated exactly like the RunPanel composer: requires a resumable run and no pending native interaction (`modalPending` guard is load-bearing — a keystroke reaching a live tmux modal pastes into the prompt).
- Save is blocked on archived tasks (server `backlogGuard` 400s it anyway); Send stays allowed (server auto-unarchives).
- `bun run typecheck` green; new pure-logic module unit-tested; existing tests still pass.

## 2. Context & constraints (Phase 1 findings)

- **Diff pipeline**: `GET /tasks/:id/diff` (`src/bun/server.ts:3136`) → `getTaskDiff` (`src/bun/worktree.ts:674`) → `TaskDiff { base, files: DiffFile[], note? }` (`src/shared/types.ts:957-990`). Each `DiffFile.hunks` is raw unified-diff hunk text. Fetch-on-open, no polling — rows are stable while the dialog is open.
- **Renderer**: `DiffDialog.tsx` has a local duplicate (`DiffDialog.tsx:194-220`) of the tested `toRows`/`DiffRow` in `src/mainview/lib/diff-rows.ts` (used by `GitHubDialog.tsx`). Rows: `{ old, neu, kind: ctx|add|del|hunk|meta, text }`. Rendering: one flex div per row, two `select-none` line-number gutters + marker + `whitespace-pre` text (`DiffDialog.tsx:222-257`).
- **Interaction precedent**: `GitHubDialog.tsx:8524+` has line-click → inline compose (stable rowKey, `group`/`group-hover` affordance) — the pattern to mirror, but it's single-line and GitHub-PR-specific.
- **Composer/backlog**: `BacklogMessage { id, text, references: TaskReference[], createdAt }` (`src/shared/types.ts:673`); `references` are strictly file/folder paths — diff-line content must go into `text`. `api.addBacklogItem(taskId, {text, references?})` (`api.ts:1060`), `api.sendRunInput(runId, line)` (`api.ts:1052`). RunPanel gating: `resumableRunId = task.runId ?? (claude-code && runs[0]?.id)` (`RunPanel.tsx:748`), `modalPending = interactions.length > 0` (`RunPanel.tsx:763`).
- **Dialog mount**: `App.tsx:725-730` passes `taskId`/`taskTitle` from `diffTask: Task | null` state — the full `Task` is available and `tasks` (2s poll) can supply a live copy.
- **Helpers available to the dialog**: `api.listRuns(taskId)` (`api.ts:1040`), `api.listPendingInteractions(taskId)` (`api.ts:1151`).
- **Conventions**: pure logic in a dedicated colocated-test module (`diff-rows.ts` precedent); no DOM/component test harness exists; `src/shared/refs.ts` (`appendReferences`) is the model for a compose helper; sends from anywhere must reuse `sendRunInput` so they're "indistinguishable from a typed one".
- **Fleet knowledge**: backlog mutations are server-frozen on archived tasks; message-to-archived auto-unarchives server-side in `orchestrator.sendInput`.

## 3. Approach & key decisions

1. **Webview-only feature.** Serialize the selection into the message *text* client-side (mirroring how `appendReferences` runs client-side). No schema change, no migration, no new routes. Rejected: a structured `diffSelections` field on `BacklogMessage` — would need sanitizers, chip rendering, its own serializer, for no user-visible gain; the quoted text is self-describing and editable.
2. **Compose inline in `DiffDialog`** (sticky footer composer when selection non-empty), not "close dialog and prefill RunPanel" — keeps the user in the diff, mirrors GitHubDialog's inline pattern.
3. **New pure module `src/mainview/lib/diff-selection.ts`** + colocated test (the `diff-rows.ts` pattern): grouping selected row indices into contiguous per-file blocks and formatting them as fenced ```diff blocks with path + line-range labels. Dynamic fence length so content containing backticks can't break out.
4. **Consolidate first**: `DiffDialog.tsx` switches to the shared `toRows`/`DiffRow` from `lib/diff-rows.ts` (deletes its local copy) rather than adding a third consumer of duplicated logic.
5. **Selection state** lives in `DiffDialog` as `Map<filePath, Set<rowIndex>>`. Row indices are stable while the dialog is open (single fetch). Shift-click extends from the last-clicked row *within the same file*. Clicking a `hunk`/`meta` row is a no-op.
6. **Gating**: on selection-composer mount (and re-checked at send click), fetch `listRuns` + `listPendingInteractions` to compute `canSend`/`modalPending` with the same rules as RunPanel. Save-for-later disabled when `task.archivedAt != null`. Enter sends when sendable, saves otherwise (never a dead key) — mirroring `RunPanel.tsx:1419`.
7. **Prop change**: `DiffDialog` takes `task: Task | null` instead of `taskId`/`taskTitle`; `App.tsx` passes the live task (`tasks.find(t => t.id === diffTask.id) ?? diffTask`) so archived state can't go stale.

### Serialization contract (implemented by T1, consumed by T3)

```ts
// src/mainview/lib/diff-selection.ts
import type { DiffRow } from "./diff-rows";
export interface DiffSelectionBlock { path: string; lines: Pick<DiffRow, "old" | "neu" | "kind" | "text">[] }
export const DIFF_SELECTION_HEADING = "Selected lines from the current diff:";
/** Contiguous runs of selected, selectable (ctx|add|del) rows for one file, in row order. */
export function groupSelectedRows(path: string, rows: DiffRow[], selected: Set<number>): DiffSelectionBlock[];
/** Heading + per-block `path (line N / lines A–B)` label + fenced ```diff snippet.
 *  Label uses new-side numbers when any line has `neu`, else `old lines A–B`.
 *  Fence is backtick-run-safe (longer than any backtick run in content).
 *  Lines re-prefixed with "+", "-", " " by kind. Empty blocks → "". */
export function formatDiffSelection(blocks: DiffSelectionBlock[]): string;
/** `${text}\n\n${formatted}` — text-only / blocks-only / both, exactly like appendReferences. */
export function composeDiffMessage(text: string, blocks: DiffSelectionBlock[]): string;
```

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Pure selection/serialization module per contract in §3 | `src/mainview/lib/diff-selection.ts`, `src/mainview/lib/diff-selection.test.ts` (new) | — | Unit tests cover grouping (contiguity, unselectable kinds skipped), labels (single line, range, del-only), backtick-safe fences, compose text/blocks-only cases; `bun test src/mainview/lib/diff-selection.test.ts` green |
| T2 | Consolidate `DiffDialog` onto shared `toRows`/`DiffRow`; switch props to `task: Task \| null`; update mount | `src/mainview/components/kanban/DiffDialog.tsx`, `src/mainview/App.tsx` | — | Local `Row`/`toRows` deleted; imports from `@/lib/diff-rows`; `App.tsx:725` passes live task; rendering unchanged; typecheck green |
| T3 | Selection UI + inline composer + send/save wiring in the dialog | `src/mainview/components/kanban/DiffDialog.tsx`, `CLAUDE.md` (one-paragraph addendum to item 7) | T1, T2 | Click/shift-click selection with visual state; sticky composer (textarea, Send, Save for later, Clear, selection count); gating per §3.6; success clears selection+text with a transient hint; dialog stays open |

## 5. Work breakdown — test tasks

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| TT1 | Written *with* T1 (colocated) — pure-function tests | `src/mainview/lib/diff-selection.test.ts` | T1 |
| TT2 | Gap pass after review: extend TT1 with any edge cases review/implementation surfaced (e.g. CRLF, empty text lines, meta rows inside a run splitting blocks) | `src/mainview/lib/diff-selection.test.ts` | T1/T3 serialization edge cases |

No component/DOM tests — the repo has no UI test harness (convention: extract logic into `lib/` and test that; T3's JSX stays thin).

## 6. Execution waves

- **Wave 1 (parallel, disjoint):** T1 (new lib files) ∥ T2 (DiffDialog refactor + App.tsx). Barrier, then commit `wave 1`.
- **Wave 2:** T3 (feature in DiffDialog, consumes T1's exports and T2's props). Commit `wave 2`.
- **Then:** Phase 5 review (opus) → Phase 6 (TT2, only if gaps) → Phase 7 `bun test` + `bun run typecheck` (haiku) → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `DiffDialog` is opened from `TaskCard`/`Column` (`onDiff`) and `RunPanel` (`onShowDiff`) — both route through `App.tsx`'s `diffTask` state, so the prop change is contained to `App.tsx` + `DiffDialog.tsx`.
- `lib/diff-rows.ts` gains a second consumer (T2) — no changes to it, so `GitHubDialog` unaffected.
- Send path is the shared `sendRunInput` → orchestrator `sendInput` (auto-unarchive, worktree rematerialize) — no orchestrator changes; a diff-composed send is indistinguishable from a typed one.
- Backlog writes go through existing guarded routes; archived-task freeze respected in UI and enforced server-side.
- Risk: RunPanel is open behind the dialog when sending — its event stream picks the message up via existing poll/SSE; no coordination needed.
- Risk: huge selections (user selects hundreds of lines) → message is large but bounded by `PER_FILE_HUNK_CAP`-capped hunks; tmux delivery already handles large pastes via `load-buffer`. No extra cap (assumption A6).

## 8. Open questions / assumptions (autonomous-mode log)

- **A1** Selection model: click toggles a line; shift-click selects the contiguous range from the last-clicked row in the same file; multi-file selections allowed. (User said "click on a line or select multiple".)
- **A2** Composer lives inline in the diff dialog (not prefilled into the RunPanel composer).
- **A3** Selected lines serialize into the message **text** (quoted ```diff blocks); no schema/migration change; backlog items store the composed text with empty `references`.
- **A4** Send gating mirrors RunPanel (resumable run + no pending interaction, re-checked at send time); Save allowed pre-first-run (that's the backlog's purpose) but blocked on archived tasks; Send allowed on archived tasks (server auto-unarchives) with a hint.
- **A5** Enter in the diff composer routes like the RunPanel composer: send if sendable, else save-for-later; Shift+Enter = newline.
- **A6** No cap on selection size.
- **A7** The context-line kind is selectable too (users often want to point at unchanged lines).
- **A8** Both gates (grill, plan approval) were self-approved under autonomous mode.
