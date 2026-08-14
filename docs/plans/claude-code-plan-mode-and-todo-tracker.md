# Plan — Claude Code plan-mode UX, Task-tools TODO tracker, and AskUserQuestion truncation fix

| Field | Value |
| --- | --- |
| Date | 2026-08-14 |
| Source | /implement request + 3 screenshots (agetor v0.1.1 running a claude /implement session) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/claude-code-plan-mode-and-todo-tracker |
| Base SHA | f67a4da |

## 1. Objective & success criteria

Three deliverables:

1. **AskUserQuestion fix** — the "Claude is asking" card must always show the full question text and *all* options, even when the native modal is taller than the visible tmux pane. No more wrong-option keystroke drives from a truncated card.
2. **TODO/phases tracker for the new Task tools** — `TodoProgressCard` reappears for current Claude Code versions (which emit `TaskCreate`/`TaskUpdate` instead of `TodoWrite`), gains a TUI-style summary header ("8 tasks · 0 done · 8 open"), and the kanban board card shows a mini progress badge (e.g. `3/8`).
3. **Plan-mode UX** — when claude is waiting for plan approval, the card shows the **complete plan markdown** (not two scraped lines) with the existing Approve / Approve+auto / Reject actions; each plan (with outcome) is **persisted** on the task like cursor's plans; a **live permission-mode chip** (plan / auto / acceptEdits…) shows in the run panel.

Success: `bun run typecheck` green, `bun test` green, `bunx playwright test` green including a new fake-driver todo e2e; manual smoke against `~/.agetor-dev` shows all three behaviors.

## 2. Context & constraints (grounded findings)

### Bug: AskUserQuestion truncation (confirmed root cause)
- Scrape tick `scrapeOnce` (`src/bun/claude-tmux.ts:3655`) captures **only the visible screen** (`capture-pane -p`, no `-S`, `:3671`), then keeps the last `SCRAPE_TAIL_LINES = 40` lines (`:3219`). The visible screen is bounded by the live window height (often well under 40 rows).
- `collectAskQuestionsFromPane` fast path (`claude-tmux.ts:2566`): a flat single question with no preview panel is parsed straight off that tail — **no pane grow, no completeness check**. A tall modal (long wrapped option descriptions) pushes header + question + option 1 off-screen; `parseModalPane` (`src/bun/claude-questions.ts:318`) then keeps option 2 as `kept[0]` (→ option 1 missing) and scoops option 1's leftover wrapped description lines as the "question" (`:377-391`) (→ wrong/truncated question).
- Danger: `POST /ask-questions/:id/answer` (`src/bun/server.ts:3959`) drives blind index-based keystrokes from the corrupted option list (`driveAskAnswers`, `claude-tmux.ts:1631`) — can select the **wrong option** in the real modal.
- The accurate source already exists: `readPendingAskQuestionsFromJsonl` (`claude-tmux.ts:2308`) reads the pending `AskUserQuestion` tool_use (full question/header/options/multiSelect) and is *preferred* — but the wait-for-JSONL guard `shouldWaitForAskJsonl`/`paneCollapsesContent` (`:2640-2652`) only fires on preview `✂ N lines hidden` markers, never on "top of modal missing". Doc comments at `claude-questions.ts:4-8,185-186` and `claude-tmux.ts:2241-2243` falsely claim the JSONL tool_use is unavailable pre-answer — stale, contradicted by the code itself.
- Existing pane-grow machinery (`PREVIEW_PANE_ROWS = 100` at `:2345`, `sliceModalRegion` `:2489`) is used only by the preview/tab path — reusable for the flat path.
- Tests: `src/bun/fixtures/askuserquestion/*.txt` (11 pane fixtures, all complete); no truncated-top fixture; `collectAskQuestionsFromPane`/`shouldWaitForAskJsonl` have zero direct tests.

### TODO tracker (exists; blind to new tools)
- `src/mainview/lib/todo-progress.ts` + `TodoProgressCard.tsx` ship today, pinned in RunPanel (`RunPanel.tsx:1262, 2575-2579`); design doc `docs/plans/claude-code-todo-progress.md` (client-side latest-wins derivation from generic tool_use events — deliberately no new stream/migration).
- **Measured evidence**: the screenshot session's JSONL has **8× `TaskCreate`, 0× `TodoWrite`**. Machine-wide corpus (320 sessions): `TodoWrite` = 0 real tool_use entries. Current Claude Code uses the Task tools.
- Wire shapes (from real JSONL):
  - `TaskCreate` tool_use `input = { subject, description, activeForm }`; its tool_result content is `"Task #N created successfully: <subject>"` (task number only appears in the tool_result).
  - `TaskUpdate` tool_use `input = { taskId: "N", status: "in_progress" | "completed" }` (only these two statuses observed; schema also allows subject/description edits and possibly other statuses — tolerate unknown fields/statuses gracefully).
  - `TodoWrite` legacy shape (`input.todos[] = { content, status, activeForm }`) must keep working.
- Board card `TaskCard.tsx` is a separate file from `RunPanel.tsx` (clean partition). Board data comes from the 2s `/tasks` poll — board progress needs a server-side summary (events aren't loaded per board card).

### Plan mode (mostly exists)
- Plumbing complete: `AGENT_OPTIONS["claude-code"].modes` includes `plan` (`src/shared/types.ts:1667-1672`); `CODE_PLAN_MODE` maps claude's toggle Plan → real `plan` (`:1483-1495`); `buildCommand` emits `--permission-mode plan` (`src/bun/agents.ts:391-399`, tested `agents.test.ts:272-296`); mid-session Shift+Tab cycling exists (`claude-tmux.ts:295-329, ~5086`).
- Approval flow exists as a pane-scraped `tmux_prompt`: `TmuxPromptCard` plan branch (`RunPanel.tsx:5414-5504`, signature `/written up a plan|Would you like to proceed/i` at `:5450`) with Approve/Approve+auto/Reject driving keystrokes via `POST /tmux-prompts/:id/answer` (`server.ts:4013-4085`). **No plan content shown beyond scraped pane text; nothing persisted.**
- JSONL evidence (real sessions): `ExitPlanMode` tool_use `input = { plan: "<full markdown>", allowedPrompts?: [{tool, prompt}] }`; approval tool_result content starts with `"User has approved your plan."` and may include `"## Approved Plan (edited by user):"` followed by the edited plan; `{"type":"permission-mode","permissionMode":"plan"|"auto"|…}` marker lines are emitted on every mode change, and every `type:"user"` line carries a top-level `permissionMode` field.
- Cursor plan infra to reuse: `TaskPlan` + `tasks.plans` JSON column (migration 041), pure transforms in `src/bun/task-plans.ts`, `PlanCard`/`PlanDialog` (ReactMarkdown via `md-components.tsx`). Cursor mutation routes are hard-gated by `planCursorKindGuard` (`server.ts:370-379`) — claude plans will be read-only records (approval stays keystroke-driven), so **no route changes needed**.
- Fake driver `makeFakeAgent` (`src/bun/agents.ts:648-744`) supports only canned env-gated scenarios; `makeFakeCursorPlanAgent` (`:767-826`) is the template for a new canned todo scenario.
- E2e harness: Playwright, `bunx playwright test`, one Vite dev server + per-worker headless Bun backends (`e2e/fixtures.ts`, base port 4600). `bun test` is scoped to `src/` via `bunfig.toml`.

## 3. Approach & key decisions

1. **Ask fix — completeness guard + JSONL preference + pane grow (evidence-based).** A pane parse is trusted only if the modal is *complete*: first parsed option number is `1` AND non-empty question text was found AND the options footer region is intact. Incomplete ⇒ treat as lossy: wait for the JSONL tool_use within the existing grace window; if still absent, grow the pane (reuse the `PREVIEW_PANE_ROWS` machinery) and re-capture. Last resort (still incomplete after grow): register what we have but **only if option numbering starts at 1**; never register a card whose first option isn't #1 — better to keep showing "claude is waiting at a prompt" than to drive wrong keystrokes. Fix the stale doc comments.
2. **Todo derivation moves to `src/shared/todo-progress.ts`** so both the webview (card) and the Bun orchestrator (board summary persistence) use one pure implementation. Task-tools derivation is stateful: `TaskCreate` appends (task number taken from its tool_result when observable, else next sequential), `TaskUpdate` mutates by `taskId`; `TodoWrite` remains snapshot/latest-wins. If both appear, the most recently updated family wins.
3. **Board summary is a persisted column** (`tasks.todo_progress`, JSON `{completed,total}`, migration 042), updated by the orchestrator's chunk handler on todo-relevant chunks by re-deriving from a filtered `run_events` query (rare chunks, cheap query; survives restarts; no reattach-replay fragility). Server-managed — not in the PATCH allow-list.
4. **Claude plans persist into the existing `tasks.plans` column** via new pure helpers in `task-plans.ts`: `ExitPlanMode` tool_use ⇒ upsert `pending` plan (content = `input.plan`, keyed by call id); matching tool_result ⇒ `approved` (capturing the user-edited plan when the `"## Approved Plan (edited by user):"` marker is present) or `rejected` otherwise. Detection lives in the orchestrator chunk handler (generic chunks already carry these) — the claude-tmux driver is untouched by this piece. Claude plans are read-only in the UI (no PATCH/approve routes; approval remains the live keystroke flow), so `planCursorKindGuard` stays as-is.
5. **Live mode chip is event-driven, no new API**: the claude driver emits a `status` chunk `permission-mode: <mode>` (sentinel-prefix pattern, like `SESSION_DIED_STATUS_PREFIX`) whenever the JSONL reports a mode change; the chip derives client-side from the latest such event. Rare events, tiny persistence cost, free history.
6. **Full-plan card sources content from the persisted pending plan** (decision 4) with a fallback scan of `displayedEvents` for the latest `ExitPlanMode` tool_use — rendered with the existing ReactMarkdown `md-components`, buttons unchanged.

### Cross-task contracts (pinned; same-wave tasks implement against these exactly)

- `src/shared/todo-progress.ts` (owned by T2) must export:
  ```ts
  export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
  export type TodoProgress = { todos: TodoItem[]; completed: number; total: number; activeForm: string | null };
  export type TodoProgressSummary = { completed: number; total: number };
  // events: chronological subset of run events; only `stream` and `data` are read.
  export function deriveTodoProgress(events: { stream: string; data: string }[]): TodoProgress | null;
  export function summarizeTodoProgress(p: TodoProgress | null): TodoProgressSummary | null;
  ```
- `src/shared/types.ts` (owned by T3) must add:
  ```ts
  export const PERMISSION_MODE_STATUS_PREFIX = "permission-mode: ";
  // Task gains: todoProgress: { completed: number; total: number } | null  (server-managed)
  // TaskPlan.status union gains "rejected" (if not already present)
  ```
  T1 imports `PERMISSION_MODE_STATUS_PREFIX` from `../shared/types.ts`; wave-1 typecheck happens at the wave checkpoint, after all three land.

## 4. Work breakdown — implementation tasks

### Wave 1 (3 parallel tasks, disjoint files)

**T1 — Ask-modal truncation fix + permission-mode emission** (owns: `src/bun/claude-questions.ts`, `src/bun/claude-questions.test.ts`, `src/bun/fixtures/askuserquestion/*`, `src/bun/claude-tmux.ts`, `src/bun/claude-tmux.test.ts`, `src/bun/claude-tmux-scraper.test.ts`)
- `claude-questions.ts`: expose a completeness verdict from `parseModalPane` (e.g. `complete: boolean` — first kept option number is 1 and question text non-empty). Do not change existing successful-parse output shapes.
- `claude-tmux.ts` ask path: fast path requires `complete`; incomplete ⇒ lossy handling — extend `shouldWaitForAskJsonl` trigger to include incompleteness (not just `✂` markers); after grace, grow the pane (reuse `PREVIEW_PANE_ROWS` resize used by the preview path) and re-capture; never register a card whose first option isn't #1. Correct the stale "JSONL not written until answered" comments (`claude-questions.ts:4-8,185-186`, `claude-tmux.ts:2241-2243`).
- `claude-tmux.ts` mode emission: in the JSONL line dispatcher, handle `{"type":"permission-mode","permissionMode":X}` marker lines (and the per-user-line `permissionMode` field as fallback) → emit `status` chunk `PERMISSION_MODE_STATUS_PREFIX + X` **only on change** (track last emitted per session). Import the constant from `src/shared/types.ts` (T3 adds it — pinned contract above).
- Tests: new truncated-top fixture (`truncated_top.txt` — starts mid-option-1 description, option 2 onward visible); unit tests for the completeness verdict, the broadened lossy trigger, and mode-change chunk emission (existing synthetic-JSONL dispatch pattern, e.g. `claude-tmux.test.ts:999`).
- Acceptance: complete fixtures still parse identically (all existing tests green); truncated fixture yields `complete: false` and no registered card from the fast path; mode marker lines produce exactly one status chunk per change.

**T2 — Shared todo derivation + card upgrade** (owns: `src/shared/todo-progress.ts` [new], `src/mainview/lib/todo-progress.ts`, `src/mainview/lib/todo-progress.test.ts`, `src/mainview/components/kanban/TodoProgressCard.tsx`)
- Implement the pinned contract in `src/shared/todo-progress.ts`: legacy `TodoWrite` snapshot semantics preserved; Task-tools accumulation — `TaskCreate` tool_use appends `{ content: input.subject, status: "pending", activeForm: input.activeForm }`, resolving its task number from the matching tool_result (`tool_use_id` join; parse `Task #N created successfully`), else next sequential; `TaskUpdate` sets status by `taskId` (string-compare; ignore unknown ids/statuses; apply `subject`/`description` edits if present). `activeForm` of the progress = the in-progress item's `activeForm`, matching current behavior.
- `src/mainview/lib/todo-progress.ts` becomes a re-export of the shared module (keep import sites working; keep its test file exercising the shared impl including new Task-tools cases with real-shape fixtures from §2).
- `TodoProgressCard.tsx`: summary header `"{total} tasks · {completed} done · {open} open"` above the checklist; visual style unchanged otherwise (semantic tokens only).
- Acceptance: unit tests cover TodoWrite legacy, TaskCreate-with-result numbering, TaskCreate-without-result sequential fallback, TaskUpdate in_progress/completed, unknown status tolerance, mixed-family latest-wins.

**T3 — Backend persistence: board summary + claude plan history + shared types** (owns: `src/shared/types.ts`, `src/bun/migrations/042_todo_progress.sql` [new], `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/task-plans.ts`, `src/bun/task-plans.test.ts`, `src/bun/orchestrator.ts`, `src/bun/orchestrator-claude-plan.test.ts` [new])
- `types.ts`: pinned additions (constant, `Task.todoProgress`, `TaskPlan` status `"rejected"`).
- Migration 042: `ALTER TABLE tasks ADD COLUMN todo_progress TEXT` (JSON, nullable). `db.ts`: parse on read (sanitized, like `parseBacklog`), stringify on write; **not** in the PATCH allow-list.
- `orchestrator.ts` chunk handler: on `tool_use`/`tool_result` chunks whose data string-matches `TodoWrite|TaskCreate|TaskUpdate`, re-derive via `deriveTodoProgress` over a filtered `run_events` query for the task (SQL `stream IN ('tool_use','tool_result') AND (data LIKE …)` — add a small `db.ts` helper) **plus the current chunk** (it may not be persisted yet when the handler runs — append it to the query result before deriving), and persist `summarizeTodoProgress` to `tasks.todo_progress` when changed.
- Claude plan history: on `tool_use` chunk with `name === "ExitPlanMode"` ⇒ `upsertDetectedPlan`-style pure helper records `pending` plan (content `input.plan`, keyed by call id, superseding a prior pending one); on the matching `tool_result` chunk ⇒ `approved` if content starts with `"User has approved your plan"` (store edited content after `"## Approved Plan (edited by user):"` when present), else `rejected`. New pure helpers in `task-plans.ts` (mirror existing style); orchestrator only wires chunks → helpers → `tasks.update`.
- Tests: task-plans unit suite for the new helpers (pending→approved with/without edit, pending→rejected, supersede); orchestrator integration test feeding synthetic chunks through the chunk handler asserting `todo_progress` and `plans` land on the task row (temp `AGETOR_DATA_DIR`, `isolation: "none"` — per repo test conventions).
- Acceptance: migration applies cleanly on an existing dev DB; summaries update latest-wins; plan lifecycle recorded; PATCH cannot touch either column.

### Wave 2 (2 parallel tasks, disjoint files) — after wave-1 checkpoint

**T4 — RunPanel: full-plan card, mode chip, plan history** (owns: `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/PlanDialog.tsx`)
- Full-plan card: in `TmuxPromptCard`'s plan branch, render the plan markdown (ReactMarkdown + `md-components`, scrollable/collapsible for long plans) sourced from the task's latest `pending` claude plan (`task.plans`), falling back to the latest `ExitPlanMode` tool_use in `displayedEvents`; keep the existing Approve / Approve+auto / Reject buttons and answer plumbing untouched.
- Mode chip: derive the latest `PERMISSION_MODE_STATUS_PREFIX` status event from `displayedEvents`; render a small chip (semantic tokens) near the heartbeat/"Agent is working…" area; hidden when no mode event exists. Suppress the raw `permission-mode: …` status line from the transcript rendering (it's chip data, not a log line).
- Plan history: render claude-kind plans via the existing `PlanCard` inline flow; `PlanDialog` gains a read-only mode for claude plans (view content — including edited/approved text — no edit/approve/revert affordances; show status badge incl. `rejected`).
- Acceptance: typecheck green; cursor plan flow unchanged (its tests still pass); mode chip and plan card render from event/task data alone.

**T5 — Board mini progress** (owns: `src/mainview/components/kanban/TaskCard.tsx`)
- Render `task.todoProgress` as a compact `3/8` badge with a `ListTodo`-style icon on the board card (semantic tokens; hidden when null; no layout jumps).
- Acceptance: typecheck green; badge appears only when the column has data.

### Wave 3 — orchestrator-inline (no agent)
- Update `CLAUDE.md`'s claude-code section: document the Task-tools/TodoWrite tracker, plan persistence + approval flow, mode chip sentinel, and the ask-modal completeness guard.

## 5. Work breakdown — test tasks

Unit/integration tests are written **inside** each wave task (repo convention: test-with-feature; see T1–T3 acceptance). Phase 6 adds the cross-layer coverage:

**T6 — Fake-driver todo scenario + e2e** (owns: `src/bun/agents.ts` [fake driver only], `e2e/todo-progress.spec.ts` [new])
- Extend `makeFakeAgent` with `AGETOR_FAKE_CLAUDE_TODOS=1`: emit canned `tool_use`/`tool_result` chunk pairs (2× TaskCreate with real-shape results, 1× TaskUpdate → in_progress) then complete — mirroring `makeFakeCursorPlanAgent`'s structure.
- Playwright spec (existing per-worker backend fixture): create a claude task (fake driver env on the backend), start it, assert the TodoProgressCard appears with "2 tasks · 0 done · 2 open" → active item, and the board card shows the mini badge after settlement.
- **E2e applicability**: applies to the tracker (full UI→API→DB loop reachable with the fake driver). The ask-modal fix and live plan/mode flows require a real interactive claude TUI — **not e2e-able**; covered by unit tests on fixtures/synthetic JSONL instead (recorded decision, not an omission).
- Run recipe (from Phase 1): `bun run typecheck`; `bun test` (scoped to `src/`); `bunx playwright test` (spawns Vite + per-worker headless backends itself; no credentials needed).

## 6. Execution waves

1. Wave 1: T1 ∥ T2 ∥ T3 → checkpoint: `bun run typecheck` + `bun test` + commit.
2. Wave 2: T4 ∥ T5 → checkpoint: typecheck + `bun test` + commit.
3. Wave 3: docs (inline) → commit.
4. Phase 5 review (opus) → Phase 6 T6 → Phase 7 full runs → Phase 8 fixes.

## 7. Blast radius & risks

- `claude-tmux.ts` (~5k lines) and `RunPanel.tsx` (~5k lines) are high-traffic files — each is owned by exactly one task per wave; changes are surgical and region-scoped.
- Ask fix behavior change: a truncated modal now *waits/grows* instead of instantly registering a (wrong) card — worst case the card appears a couple of seconds later; the old behavior could drive wrong answers, so this trade is deliberate.
- Pane grow on flat questions resizes the tmux window briefly (same mechanism the preview path already uses; restored by existing `restorePaneSize`).
- `tasks.todo_progress` writes are chunk-driven but rare (only on todo-family tool calls); latest-wins JSON, no contention.
- Reattach/boot: summary column persists; chunk-handler re-derivation is idempotent on replayed chunks.
- Cursor plan flow untouched (guard rails: existing `orchestrator-cursor-plan.test.ts` must stay green); codex/gemini/cursor drivers untouched.
- Rollback: features are additive (new column nullable; new card states render only on new data); revert = revert the branch.

## 8. Open questions / assumptions

- Assumption: `TaskUpdate` may carry statuses beyond `in_progress`/`completed` (e.g. deletions) in future CLI versions — derivation ignores unknown statuses and ids rather than erroring.
- Assumption: the plan-approval modal signature (`/written up a plan|Would you like to proceed/i`) still matches the user's claude version; T4 does not change detection, only enrichment. If the wording drifted, the card falls back to today's behavior (buttons from scraped text) — flagged for the review pass, not blocking.
- Assumption: permission-mode marker lines exist on the claude versions in use (verified against sessions from July–Aug 2026 on this machine).
