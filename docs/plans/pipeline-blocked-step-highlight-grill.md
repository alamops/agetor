# Grill — pipeline step attention highlight + card action opens the step

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Source | Pipeline goal (step 2 "Grilling" of "My Implementation Pipeline") + investigation brief `docs/plans/pipeline-blocked-step-highlight-investigation.md` |
| Mode | interactive, answered by the owner (two structured passes, every question answered) |
| Flags | none |
| Branch | `fix/blocked-step-highlighted-color` |

Situation numbers (rows 1–5) refer to the matrix in the investigation brief §1.3:
1 = asking mid-turn, 2 = a question still pending after the turn, 3 = error (API error / session died / unknown command),
4 = missing/invalid handoff or the step reported `status: "blocked"`, 5 = run-level block (step cap, missing agent profile, incomplete join, archived-parent hold).

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope — states | Which situations get the card-style highlight on the run-view node? | **All five.** Rows 1–4 highlight the step's own node. Row 5 (run-level, `taskId: null`) highlights the node named by the block's `stepId` (the step the run is stuck at), even though that step is not in `run.active`. Rule: whenever the parent card glows, some node glows. | owner |
| D2 | Look — tone | One amber look, or red for errors? | **Amber for everything**, errors included. Matches the card, which shows amber + "Review" for errors. No red/danger attention variant. | owner |
| D3 | Look — recipe | What exactly is "the card's look" on a node? | The card's recipe: static `ring-2 ring-warning/60 ring-offset-2 ring-offset-background` + a separate `pointer-events-none absolute inset-0 rounded-[inherit]` glow overlay with static `boxShadow: 0 0 14px hsl(var(--warning) / 0.85)` whose **opacity** pulses (`animate-awaiting-pulse motion-reduce:animate-none`). No `box-shadow`/`filter` keyframes on the node (they clobber `ring-*` and cost a paint per frame), and no new colour token. | owner (accepted default 2); evidence `TaskCard.tsx:110,361-367`, `tailwind.config.js:87-90,112` |
| D4 | Look — mid-turn conflict | A step asking mid-turn is still running. Blue "working" pulse or amber? | **Amber replaces blue** on that node (attention wins, same as the card, which shows Answer over the running state). | owner (accepted default 1) |
| D5 | Accessibility — label | Should the node say what it needs? | **Yes: a small chip in the node's title row**, using the card button's words: `Answer` (1 pending), `Answer (N)` (N > 1, N = that step task's `pendingInteractionCount`), else `Review` (rows 3, 4, 5, and row 2 if the count has already dropped). Tooltip carries the block message when there is one. Fits the existing title row (like the Start badge), so node height doesn't change. Satisfies WCAG 1.4.1 (colour isn't the only signal). Non-interactive: the whole node is already clickable. | owner |
| D6 | Look — tokens | Card button uses literal `bg-amber-500`; what does the new chip use? | Semantic tokens only (`warning`, e.g. `bg-warning/15 text-warning`), per the UI rule "new UI must use these, never literal palette classes". The card's literal amber stays as is. | repo convention (CLAUDE.md "UI conventions") |
| D7 | Accessibility — motion | Reduced motion | Amber glow uses `motion-reduce:animate-none`. **The existing blue "working" pulse gets `motion-reduce:animate-none` too** (one class in `VISUAL_CLASSES.active`). | owner (accepted default 9) |
| D8 | Freshness | Highlight latency on a new question | **Forward `interaction` global events into the run view's event store** (`pipeline-events.ts`, gate at `App.tsx:1097-1099`) so the run view refetches right away instead of on the next 2 s poll. The new per-node state must be part of `nodeVisualSignature` and the identity-stable merge (`PipelineRunView.tsx:492-499,519-534`) or it won't repaint. | owner (accepted default 3); evidence brief §1.2 |
| D9 | Entry points | Which ways of opening a pipeline land on the step that needs you (run view + that step's panel)? | **The attention paths only:** (a) the card's amber **Answer / Answer (N) / Review** button; (b) the "Waiting on you" toast (retargeted step toast); (c) the "Pipeline needs you" toast; (d) the macOS notification click (`open_task` deep link) that goes with those toasts. **These keep landing on the run view only:** card body click, context-menu "Open pipeline", the Worktrees dialog row, and the card's non-attention **Open** button (done/cancelled/idle). The body and button now behave differently, so the button needs its own callback threaded through `Column` and added to its hand-written memo comparator (`Column.tsx:105-121`); it must be `useCallback`-stable. | owner |
| D10 | Entry points — Review | Does "Review" (rows 3, 4) also open the step panel, though the panel covers the run view's Retry/Advance side panel? | **Yes. Answer and Review both open the step panel** when a step task is tied to the attention. The user reads the error or missing handoff in the transcript; Escape closes the panel and shows Retry/Advance. **Row 5 has no step task, so it lands on the run view only** (the highlighted node and the Blocked banner are visible). | owner |
| D11 | Which step | Fan-out: several steps need you at once. Which one opens? | **Pending question first:** the earliest-launched active execution whose step task has `pendingInteractionCount > 0`; if none, the first `run.blocked` entry with a non-null `taskId`; if none (only run-level blocks), run view only. The other steps stay highlighted on the canvas behind the panel. | owner |
| D12 | Which step — toast | The "Waiting on you" toast already knows the exact step (`ev.taskId`). Use it or re-resolve? | Open **the step the toast names**, if that step row is in the polled list; otherwise run view only. | judgment (follows from D9/D11 + default 6; low stakes) |
| D13 | Stale target | What if the state changed between render and click? | Resolve the target **at click time** from data already in App's `tasks` state (step rows + the trimmed `pipelineRun`, which keeps `active`/`blocked`). If the step isn't there yet (≤ 2 s after creation) or no longer needs you, land on the run view only. **No extra fetch, no deferred "open after load" request.** | owner (accepted default 6); evidence brief §1.4 |
| D14 | Leftover panel | Run-view-only landing while another task's panel is still open | A run-view-only landing (card body, Open button, context menu, Worktrees row, row-5 attention) **closes a leftover panel from another task**, so the run view isn't covered by an unrelated task. | owner (accepted default 5) |
| D15 | Toast cleanup | The retargeted toast is keyed on the parent id, but opening a step's panel dismisses by the step id | Landing on a step through any attention path **also dismisses the parent-keyed "Waiting on you" / "Pipeline needs you" toast** (today it would stay up over the panel). | owner (accepted default 4); evidence brief §5 (`App.tsx:798-801`) |
| D16 | Navigation guard | Unsaved pipeline editor | Every landing goes through `navigate`. If the user cancels "Discard unsaved pipeline changes?", **nothing opens** (no step panel over the editor). | owner (accepted default 7); evidence `App.tsx:366-382` |
| D17 | Canvas | Bring the highlighted node out from under the 720 px panel? | **No auto-pan.** | owner (accepted default 8) |
| D18 | Non-attention review state | An active execution sitting in `review` waiting for a manual Advance with no block (`reviewActive`) | **No highlight**, because the card doesn't glow for it either (parent run is `running`, no pending count). | owner (accepted default 10); evidence `PipelineRunView.tsx:768-779` |
| D19 | Unchanged surfaces | What must not change | Pipeline **editor** canvas (passes no `visual`), **TUI/CLI** (no web-only state there; the TUI already answers a parent's step cards via `g`), **node click** and the run view's own **"Open step"** button, the parent **board card's** own look. | owner (accepted default 11) |
| D20 | Acceptance | What counts as done? | **Unit + e2e.** Unit: the visual-state derivation (all five rows plus the mid-turn amber-over-blue case, row 5 on a non-active step, row-4 `step-blocked`, and the no-highlight `reviewActive` case), the chip label rule, and the new "which step needs you" resolver (question first, then first task-level block, then null; fan-out ordering; stale/missing rows). Playwright (one run at a time, `e2e/pipelines-run.spec.ts` helpers, existing hooks only): (1) mid-turn question via `__agetor_fake_fx_permission__` in step instructions → node shows the attention state + `Answer` chip, card's Answer opens run view **and** the step's RunPanel; (2) `AGETOR_FAKE_CLAUDE_API_ERROR=1` → node attention + `Review`, Review opens the step panel; (3) `__agetor_fake_claude_handoff__:missing` → node attention + `Review`; (4) a run-level block (e.g. `maxSteps` cap) → the stuck step's node highlighted, card button lands on the run view only, no panel; (5) card **body** click on an awaiting pipeline → run view only. Plus `bun run typecheck` green and the existing unit + pipeline e2e suites green. | owner |
| D21 | Docs | What docs change | Update `CLAUDE.md` item 19 (run-view node visuals, attention chip, which paths open the step, interaction forwarding) and `docs/plans/pipelines.md` (visual-states line ~199, open paths). Item 9 (context menu) is unchanged because the menu is unchanged. | owner (accepted default 12) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Node attention styling for rows 1–5 (`StepNode` + `stepVisualState`) | in this change | D1–D4 |
| `stepVisualState` reading `pendingInteractionCount` (row 1 currently reads `active`) | in this change | D1, D4 |
| Run-level blocks highlighting a non-active step's node (row 5 currently shows nothing) | in this change | D1 |
| Attention label chip on the node | in this change | D5 |
| `nodeVisualSignature` + node-data merge carrying the new state/label | in this change | D8: required or the node never repaints |
| Forwarding `interaction` events to the run view store | in this change | D8 |
| Reduced-motion on the existing blue pulse | in this change | D7, owner accepted |
| Card amber button → run view + step panel (new callback through `Column` + comparator) | in this change | D9 |
| "Waiting on you" toast, "Pipeline needs you" toast, OS-notification click → step | in this change | D9, D12 |
| Parent-keyed toast dismissal on step landing | in this change | D15 |
| Closing a leftover panel on run-view-only landings | in this change | D14 |
| Unit + Playwright coverage listed in D20 | in this change | D20 |
| CLAUDE.md item 19 + `docs/plans/pipelines.md` | in this change | D21 |
| Card body click / context-menu "Open pipeline" / Worktrees row landing on the step | out of scope | owner decision D9: those are "browse" paths and stay run-view-only (a decision, not a deferral) |
| A new context-menu entry ("Answer"/"Open waiting step") | out of scope | owner decision D9; the menu's entry stays "Open pipeline" |
| Red/danger attention tone for errors | out of scope | owner decision D2 |
| Auto-panning the canvas around the panel | out of scope | owner decision D17 |
| TUI / CLI equivalents | out of scope | D19: no run-view canvas there; the TUI already answers step cards via `g` |
| Replacing the card's literal `bg-amber-500` with tokens | out of scope | pre-existing exception on a surface this change doesn't restyle; different ticket |
| Server / DB / schema changes | out of scope | brief §3: every needed field is already on the wire |

## Assumptions still open

- **"Earliest-launched" = `run.active` array order** (D11). Verified: the runner only appends on launch (`pipeline-runner.ts:776`, `run.active.push({ stepId, taskId, seq })`) and only removes on settle (`:2009` splice), and a Retry re-runs an execution in place without re-inserting it. So array order is launch order; `seq` is available as a tie-break if the planner prefers it explicitly.
- **Row 5 target node = `block.stepId`.** Verified: every run-level block site in `pipeline-runner.ts` sets `stepId` (`:218` join-incomplete, `:530-640` step-cap / profile-missing / archived hold, `:840`, `:957`, `:1811`). One edge: `:957` names a step that "no longer exists in this run's snapshot", so it matches no node and highlights nothing. The side-panel banner still covers it; no fallback target is invented.
- **Chip width.** It's assumed to fit the 240 px node's title row beside a truncated name, the Start badge and the Split/Merge glyphs. If it doesn't, the name truncates sooner; the node must not grow taller (D5).
- **Row 2 label.** If the pending count has already dropped to 0 while the `step-blocked` "is waiting for you" block is still there (between ticks), the chip reads `Review`, the same thing the card shows at that moment.
- **OS-notification click** is assumed to fire only for the parent-level toasts covered by D9 (the `open_task` deep link carries the parent id, `toasts.ts:47`). If the planner finds other notification kinds that open a pipeline parent, apply the D9 rule: attention notifications land on the step, everything else on the run view.
