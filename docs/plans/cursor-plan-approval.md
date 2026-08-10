# Plan — Cursor Plan Visualizer & Approval

| Field | Value |
| --- | --- |
| Date | 2026-08-10 |
| Source | /implement conversation (Cursor plan visualizer + approval with auto message sending) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/cusror-plan-viewer |
| Base SHA | dfdfa71060c11cea43c12d2db703569437c7b70c |

## 1. Objective & success criteria

When a Cursor task's turn ends because the agent wrote a plan and stopped (the common "finished after planning" behavior), agetor must:

1. Detect the state and persist a **plan record** on the task.
2. Render a highlighted **plan card** in the RunPanel messages list (replacing the generic `createPlanToolCall` tool block); clicking opens a **plan modal**.
3. The modal shows the plan as rendered markdown; while the plan is pending it is **editable**.
4. Buttons: **Approve Plan** (unedited) / **Save & Approve** (edited) / **Revert Changes** (edited, resets to original, stays open) / **Chat about it** (closes modal, focuses composer) / **X** close.
5. Approving writes the (possibly edited) plan to a `.plan.md` file **inside the task worktree** and **auto-sends** an approval message to the agent (spawning a `--resume` turn).
6. After approval the card stays in the stream; the modal becomes read-only with a disabled **Approved** button. Edits are frozen.
7. Unapproved edits persist server-side; closing the modal with unsaved changes prompts "Save & close / Close without saving".

Success = `bun run typecheck` green, `bun test` green including new orchestrator-level tests driven by the fake cursor driver, and the flow demonstrably works end-to-end against the fake driver.

## 2. Context & constraints (grounded findings)

**Spike-grade evidence (measured against prod DB, 140 real cursor runs, 5 real plan occurrences — 2026-08-10):**

- Cursor's plan flow emits `tool_call` `switchModeToolCall` (`args.targetModeId: "plan"`) then `createPlanToolCall` with **full plan markdown inline** at `input.createPlanToolCall.args.plan`, plus `name`, `overview`, `todos`, `phases`, `isProject`. In **all 5** real cases, `createPlanToolCall` was the **last `tool_use` of its run** and the run resolved `succeeded`. Detection trigger: *run succeeded AND its last `tool_use` event has name `createPlanToolCall`*. (8 `switchModeToolCall` vs 5 `createPlanToolCall` — a mode switch alone is not a plan; trigger only on the plan tool.)
- `tool_result` is `{success: {}, planUri: ""}` — **headless cursor-agent never writes a plan file** (`~/.cursor/plans/*.plan.md` files are IDE-only; none match agetor runs). The plan exists only in the tool args and the agent's conversation context. An edited plan must reach the agent explicitly.
- Cursor `call_id`s **contain an embedded newline** (`"call-…-174\nfc_…"`) — never use a raw call_id in filenames or URL path segments; derive a sanitized short id.

**Key code anchors:**

- Driver: `src/bun/cursor-tmux.ts:188-269` (`mapCursorEvent`), `bestEffortToolName` `:140-151` (yields `createPlanToolCall`), turn resolution `resolveCursorDone` `:394-408`.
- Run settlement: `orchestrator.ts:1037-1136` (`attachDoneHandler`) — `newStatus === "succeeded"` is computed here and the column flips to `review` (`:1114-1118`). This is the detection hook point.
- Follow-up turns: `orchestrator.sendInput` (`orchestrator.ts:1417-1477`, cursor branch `:1464-1469`) → `sendCursorTurn` (`:1642-1739`) — queues the line if a turn is in flight, else spawns `cursor-agent --resume` now. Route: `POST /runs/:id/input` (`server.ts:4010-4025`).
- Persistence precedent: `tasks.backlog` JSON column (migration `025`), `tasks.draft` (migration `029`), parse/sanitize in `db.ts` (`parseBacklog`), routes + `backlogGuard` (`server.ts:323-336`, `3887-3967`). Latest migration is `040` (saved prompts) — verify the next free number at implementation time.
- Webview stream: `RunPanel.tsx` `RunEventList:3561`, `renderEvent` switch `:3671-3719`, `ToolUseBlock:4228` (generic cursor tool rendering; `ExitPlanMode` interactive treatment `:4230,4248,4301`), `toolIcon:4719` / `formatToolInputSummary:4765`. Sections memo `:3638` is perf-load-bearing — derive plan-card state inside the existing memos.
- Modal: `src/mainview/components/ui/dialog.tsx` (controlled `open`/`onClose`, nested-dialog stack, focus trap). Best worked example: `DiffDialog.tsx` (fetch-on-open, X button `:646-648`, gated send `doSend():570-596` with the **pre-send `listPendingInteractions` re-check** — load-bearing recipe).
- Composer focus: `sendRef` (`RunPanel.tsx:1759`, attached `:2811`); canonical insert+focus idiom `MessageHistoryPicker` (`:2881-2903`) — `requestAnimationFrame(() => el.focus(); el.setSelectionRange(...))`. Plan modal state must live **inside `RunPanelBody`** so "Chat about it" reuses `sendRef` with no new plumbing.
- Send gating: `resumableRunId = task.runId ?? (claude-only fallback)` (`RunPanel.tsx:1508-1509`), `modalPending` (`:1523`), `send()` guards (`:1926-1990`). `api.sendRunInput` is `retry: false` (non-idempotent).
- Markdown: `AssistantBlock` (`RunPanel.tsx:4086-4094`) — `ReactMarkdown` + `remarkGfm` + `.agetor-md` class. Use this for plan display (better than `ExitPlanMode`'s plain `<pre>`).
- Styling: use the `primary` ring treatment (`border-primary/60 ring-1 ring-primary/40`, like claude's plan-ready card `:5409`), semantic tokens only.
- Tests: `orchestrator-cursor.test.ts` (mkdtemp `AGETOR_DATA_DIR` **before importing db**, `AGETOR_CURSOR_DRIVER=fake`, `AGETOR_CURSOR_BIN=/bin/echo`); fake-driver env hooks precedent `agents.ts:669-698` (`AGETOR_FAKE_CLAUDE_*`), cursor fake branch `agents.ts:808-820`.
- React gotchas (peer knowledge): StrictMode double-invoke destroys server state if flush-on-unmount effects read ref mirrors out of lockstep; the 2s-polled task object can be ~2s stale for seeding. Mitigation here: **no autosave / no flush-on-unmount** — plan edits persist only on explicit Save actions.

## 3. Approach & key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Detection point | Server-side, in `attachDoneHandler` on `succeeded` for cursor-kind tasks: read the run's last `tool_use` from `run_events`; if `createPlanToolCall`, upsert a plan record | Single query at settlement; works for reattach/restart (run_events are durable, cursor logs are deleted at turn end). *Rests on spike evidence (5/5 runs).* |
| Plan storage | New `tasks.plans` JSON column (`TaskPlan[]`), migration + `parsePlans` sanitizer, mirroring `backlog` | House pattern; rides the 2s `/tasks` poll into the UI for free; survives archive/restore. |
| Plan identity | `plan.id` = 8-char hash of the raw `call_id` (which contains `\n`); raw `toolCallId` kept on the record for event↔card matching | call_id is unsafe for URLs/filenames. |
| Lifecycle | `pending` → `approved` (terminal) or `superseded` (a newer `createPlanToolCall` run lands while this one is pending). Chat turns do NOT invalidate a pending plan | Owner's choice: approvable until superseded. |
| Edits | `editedContent` field, written only by explicit Save actions (`Save & Approve`, or "Save & close" on the dirty-close prompt). `Revert Changes` = clear to original (+ clear persisted draft). No autosave | Owner's choice: persist drafts; explicit saves avoid the StrictMode/flush-on-unmount trap entirely. |
| Approval delivery | `POST /tasks/:id/plans/:planId/approve`: write effective plan (edited ?? original) to `<worktree>/.cursor/plans/<slug>_<planId>.plan.md`, then `orchestrator.sendInput(task.runId, message)` | Owner's choice: file in worktree (IDE convention), plain approval message referencing the file — no full-plan embed for auto mode. |
| Approval message | Unedited: "The plan is approved — proceed with the implementation. It is also saved at `<relpath>` for reference." Edited: "The plan is approved **with edits by the user** — the approved version is saved at `<relpath>`; read it and follow that version, it supersedes your original plan. Good to go." | Owner's wording intent. |
| Ask-mode fallback | If the task's effective mode is `ask` (propose-only — the resumed turn may be unable to read files), append the full effective plan inline to the approval message | Owner's choice. |
| Kanban | No column changes — run still lands in `review` as today | Not requested; keeps blast radius small. |
| UI surface | Plan card replaces the generic `ToolUseBlock` for matched `createPlanToolCall` events (cursor tasks only); modal state owned inside `RunPanelBody`; new `PlanDialog.tsx` component | Card+click (owner's choice); `sendRef` focus for "Chat about it" with zero new plumbing. |
| Approve send safety | Pre-approve re-check of `listPendingInteractions` in the dialog (DiffDialog recipe), server re-validates plan status + resumable run atomically | Cursor has no tmux prompts today, but the guard is cheap and future-proof; server is the source of truth. |
| Scope | Cursor only. Claude keeps its native ExitPlanMode/tmux flow; codex/gemini untouched | Owner's framing. |

**Server-side `TaskPlan` shape** (in `src/shared/types.ts`):

```ts
interface TaskPlan {
  id: string;              // 8-char sanitized hash of toolCallId
  toolCallId: string;      // raw call_id (may contain \n) — matches the tool_use event
  runId: string;
  name: string | null;     // args.name
  content: string;         // original args.plan markdown
  editedContent: string | null; // persisted unapproved edits
  status: "pending" | "approved" | "superseded";
  createdAt: number;
  approvedAt: number | null;
  approvedEdited: boolean; // approved with user edits?
  filePath: string | null; // worktree-relative path written at approval
}
```

## 4. Work breakdown — implementation tasks

**T1 — Foundation (types + migration + db)** — *Wave 1*
Files owned: `src/shared/types.ts`, `src/bun/migrations/0NN_task_plans.sql` (next free number), `src/bun/migrations/index.ts`, `src/bun/db.ts`, new `src/bun/task-plans.ts`.
- Add `TaskPlan` to shared types; `plans: TaskPlan[]` on `Task`.
- Migration: `ALTER TABLE tasks ADD COLUMN plans TEXT NOT NULL DEFAULT '[]'`.
- `db.ts`: `parsePlans` sanitizer on read (mirror `parseBacklog` exactly), stringify on insert/update.
- `task-plans.ts`: pure helpers — `planIdFromCallId(callId)` (8-char fnv/djb2 hex), `upsertDetectedPlan(task, {toolCallId, runId, name, content})` (dedup by toolCallId, preserve existing edits/status, mark other pendings superseded), `setEditedContent`, `approvePlan` list-transform, `planSlug(name)` filename slugifier.
Acceptance: typecheck green; helpers are pure list transforms over `tasks.update` like `backlog.ts`.

**T2 — Orchestration + routes (bun)** — *Wave 2*
Files owned: `src/bun/orchestrator.ts`, `src/bun/server.ts`, `src/bun/agents.ts`.
- Detection in `attachDoneHandler`: on `succeeded` + cursor-kind task (resolve kind the same way the cursor sendInput branch does — aliased harnesses must work), query the run's last `tool_use` event; if `createPlanToolCall`, extract `args.plan`/`args.name` and upsert via `task-plans.ts`.
- `PATCH /tasks/:id/plans/:planId` `{editedContent: string|null}` — guarded (404 missing, archived 4xx like `backlogGuard`, 400 if plan not `pending`). Returns updated `Task`.
- `POST /tasks/:id/plans/:planId/approve` — validates pending + cursor kind + `task.runId` present; writes `<cwd>/.cursor/plans/<slug>_<id>.plan.md` (cwd = `task.worktreePath ?? task.workdir`; `mkdir -p`); builds the approval message (edited vs not; ask-mode → append full plan); calls `orchestrator.sendInput`; on delivery marks plan approved (approvedAt, approvedEdited, filePath) and returns the updated `Task`. If sendInput reports not-delivered, do NOT mark approved — return the reason.
- `agents.ts`: fake-driver hook `AGETOR_FAKE_CURSOR_PLAN=1` in the cursor fake branch — emits a realistic `tool_use` chunk (name `createPlanToolCall`, `input.createPlanToolCall.args.plan` fixture, call_id containing `\n`) + `tool_result`, then resolves done(0), so orchestrator tests can drive the full flow.
Acceptance: typecheck green; flow reachable end-to-end with the fake driver.
Depends on: T1.

**T3 — Webview (card + modal + api)** — *Wave 2 (disjoint files from T2)*
Files owned: `src/mainview/lib/api.ts`, `src/mainview/components/kanban/RunPanel.tsx`, new `src/mainview/components/kanban/PlanDialog.tsx`.
- `api.ts`: `savePlanEdit(taskId, planId, editedContent)`, `approvePlan(taskId, planId)` (both `retry: false` for approve; house `j()` style).
- `RunPanel.tsx`: match `tool_use` events whose parsed id equals a `task.plans[*].toolCallId` (cursor tasks only) inside the existing memo chain; render `PlanCard` (primary-ring card: ClipboardList icon, plan name, status badge — "Awaiting approval" / "Approved" / "Superseded", "View plan" hint) instead of the generic `ToolUseBlock`. Also add `createPlanToolCall` to `toolIcon`/`formatToolInputSummary` as fallback polish for unmatched cases.
- Modal state `useState<TaskPlan | null>` in `RunPanelBody`; pass opener down to `RunEventList` like `onInteractionResolved`.
- `PlanDialog.tsx` (controlled `Dialog`): pending → Preview/Edit toggle (markdown via the `AssistantBlock` idiom / `.agetor-md`; edit via `Textarea` seeded `editedContent ?? content`); approved/superseded → markdown view only. Footer: unedited → `Approve Plan` + `Chat about it`; edited/dirty → `Save & Approve` + `Revert Changes` + `Chat about it`; approved → disabled `Approved` button. X button in header (DiffDialog pattern). Dirty-close prompt (nested dialog): "Save & close" (PATCH draft) / "Close without saving". Approve: pre-check `listPendingInteractions` (DiffDialog recipe) then `api.approvePlan`; disable buttons while in flight; surface server error text on failure; reflect approved state immediately from the returned Task (don't wait for the poll).
- "Chat about it": close modal + `requestAnimationFrame(() => sendRef.current?.focus())`.
Acceptance: typecheck green; card renders from `task.plans` + events; all five buttons behave per spec.
Depends on: T1 (types only — parallel-safe with T2).

## 5. Work breakdown — test tasks

**TT1 — Orchestrator + helpers tests** — covers T1+T2. Files owned: new `src/bun/orchestrator-cursor-plan.test.ts`, new `src/bun/task-plans.test.ts` (+ may touch nothing else).
- `task-plans.test.ts`: pure-unit — id hashing (newline call_ids), upsert dedup preserving edits, supersede transition, slug sanitization.
- `orchestrator-cursor-plan.test.ts` (model: `orchestrator-cursor.test.ts`; mkdtemp data dir before db import, `AGETOR_CURSOR_DRIVER=fake`, `AGETOR_FAKE_CURSOR_PLAN=1`): run ends with plan → `task.plans[0].status === "pending"` with correct content; PATCH edit persists; approve → `.cursor/plans/*.plan.md` written with effective content, plan `approved`, a new run spawned (approval message observable via the fake driver / run_events `user` event); approve on non-pending → 400-shape error; archived task PATCH rejected; second plan run supersedes the first; unedited vs edited vs ask-mode message content assertions.
**E2e:** not applicable as an automated layer — the repo has no UI e2e harness (bun test only, webview untested by convention), and standing one up is out of scope. The orchestrator-level fake-driver test IS the integration test for the full server flow; UI verification is a manual smoke pass in `bun run dev:hmr` against `~/.agetor-dev` (per house dogfooding rule). Recorded as a deliberate decision, not an omission.

## 6. Execution waves

- **Wave 1:** T1 (foundation). Checkpoint: typecheck + commit.
- **Wave 2:** T2 ∥ T3 (disjoint files; both depend only on T1). Checkpoint: typecheck + commit.
- **Wave 3 (Phase 5):** code review (opus) of full diff.
- **Wave 4 (Phase 6):** TT1. Then Phase 7: `bun run typecheck` + `bun test` (haiku runner). Phase 8 fixes as needed.
- Orchestrator (me) closes with: CLAUDE.md cursor-section note about the plan-approval flow + workdone/knowledge updates.

## 7. Blast radius & risks

- `attachDoneHandler` is shared across all agents — the detection branch must be strictly gated on cursor-kind + succeeded, and must never throw (wrap; a detection failure must not break run settlement).
- `tasks.plans` column: `parsePlans` must sanitize corrupt JSON to `[]` (crash-safe reads, house rule from `parseBacklog`).
- `RunEventList` perf memos: plan-card matching must live inside existing `useMemo`s, keyed properly — a naive per-render scan would regress long-conversation perf (documented hazard).
- Approve is non-idempotent (sends a message): server validates `status === "pending"` before sending, so double-click / stale-poll double-approve is rejected server-side.
- Writing into the worktree: `.cursor/plans/` will appear in the task's diff — intended (owner's choice). `mkdir` recursive; failure to write → approve aborts with error (no message sent, plan stays pending).
- Cursor tasks with `isolation: none` write into the raw workdir — same rule (cwd = workdir), acceptable.
- Migration append-only; never renumber (check the real next number — `040` was latest at investigation time; branches merge fast here).

## 8. Open questions / assumptions

- Assumption: `task.runId` remains set after a cursor run completes (only orphan-reconciliation nulls it), so approve-after-idle can `sendInput(task.runId)`. **Implementer must verify** in `attachDoneHandler`; if it can be null, fall back to newest run id for cursor (mirroring what `sendCursorTurn` needs).
- Assumption: mode for ask-detection = `task.mode` (effective mode resolution as `buildCommand` does; `null` → `auto`).
- Superseded plans keep their file? They never wrote one (file is written at approval only) — no cleanup needed.
- "Chat about it" naming: shipping as `Chat about it` (owner may rename later; trivial).
