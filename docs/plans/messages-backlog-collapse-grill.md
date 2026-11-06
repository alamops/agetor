# Grill — collapse / expand the task messages backlog

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Source | Agetor task prompt “Collapse / Expand Messages Backlog on Tasks” (id `df38cb35-4ba1-4073-8449-c6db9673d014`), quoted verbatim in `docs/plans/messages-backlog-collapse-investigation.md:12-14`; investigation brief at `docs/plans/messages-backlog-collapse-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds |
| Answers | `docs/plans/messages-backlog-collapse-grill/round-1/answers.json`, `docs/plans/messages-backlog-collapse-grill/round-2/answers.json` |
| Flags | none |
| Spec | In repo: `docs/plans/messages-backlog-collapse-investigation.md` (the task prompt is quoted at lines 12–14) |

## One-way doors awaiting a human

None. The change is pure view state: no data migration, no API contract, no auth/tenancy, no money, no production setting.

## Decisions

| # | Topic | Question | Answer | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Surface | Which “backlog” collapses? | The saved-drafts tray above the composer (`BacklogTray` in `RunPanel.tsx`), not the kanban `backlog` column. | owner (round-1/answers.json#surface; accepted recommendation) | n/a — owner |
| 2 | Default state | What state does the tray open in? | Expanded, always; only an explicit click collapses it. | owner (round-1/answers.json#default-state; accepted recommendation) | n/a — owner |
| 3 | Auto-collapse | Should it collapse automatically at a count? | No. The threshold question was not applicable because the default is expanded. | owner (round-1/answers.json#auto-threshold, `not_applicable`) | n/a — owner |
| 4 | Persistence | How long is the collapse choice remembered? | **Session only** — local `useState` in `BacklogTray`; no `localStorage`, no server preference. Resets on task switch, subagent-tab switch, panel close and restart. | owner (round-1/answers.json#persistence — **overrode** the recommended `global`) | n/a — owner |
| 5 | Inline-edit conflict | What if the tray is collapsed while a row is being edited? | Block collapse while `editingId !== null`, with a hint such as “Save or cancel your edit first”. Because editing is blocked, the list can safely unmount when collapsed. | owner (round-1/answers.json#edit-conflict; accepted recommendation) | n/a — owner |
| 6 | Save while collapsed | Does saving a new draft expand the tray? | No. Stay collapsed and update the count; the existing `send-failed` toast still covers the background re-stash path. | owner (round-1/answers.json#save-while-collapsed; accepted recommendation) | n/a — owner |
| 7 | Collapsed header | What does the collapsed header show? | Keep the icon, “Backlog”, count and chevron; swap the hint to `saved messages — expand to review` while collapsed. The expanded hint stays as today (including the archived variant). | owner (round-1/answers.json#collapsed-header; accepted recommendation) | n/a — owner |
| 8 | Expanded height | Does “expand” mean the current capped list? | Yes — keep `max-h-40` (160 px) at rest and `max-h-72` (288 px) while editing. “Expand” restores today's view, not an all-items view. | owner (round-1/answers.json#expanded-height; accepted recommendation) | n/a — owner |
| 9 | Interaction & a11y | What is the toggle? | The whole header is one full-width `<button>` with a leading chevron, `aria-expanded` + `aria-controls`, `data-testid` hooks (`backlog-tray`, `backlog-toggle`, `backlog-list`) and `data-state`; no height animation, only the chevron rotates. | owner (round-1/answers.json#interaction; accepted recommendation) | n/a — owner |
| 10 | Toggle visibility | Show it for a one-item tray? | Yes — every non-empty tray shows the toggle. | owner (round-1/answers.json#always-visible; accepted recommendation) | n/a — owner |
| 11 | Archived tasks | Is the toggle available on archived read-only tasks? | Yes — collapse is pure view state; drafts are visible when expanded and the read-only hint remains. | owner (round-1/answers.json#archived; accepted recommendation) | n/a — owner |
| 12 | Lifecycle edges | What survives task/subagent/empty transitions? | Subagent tabs still hide the tray entirely; an empty backlog still hides it. **Round-2 amendment:** because the state is session-only and the tray unmounts when empty, removing the last draft forgets the collapsed state — the next saved draft opens expanded. | owner (round-1/answers.json#lifecycle + round-2/answers.json#empty-tray-state; both accepted recommendations) | n/a — owner |
| 13 | Non-goals | What is explicitly out? | Per-message collapse, expand-all/collapse-all, virtualization for huge lists, backend/preference sync, a Settings toggle, and a new keyboard shortcut. | owner (round-1/answers.json#non-goals; accepted recommendation) | n/a — owner |
| 14 | Acceptance | Tests and docs? | One new Playwright spec (default visibility, toggle + `aria-expanded`, list hidden, count visible, transcript grows) plus an update to `docs/architecture/messages-backlog.md`. The existing task-switch spec stays as-is because the default remains expanded. No `CLAUDE.md:175` change because no new `localStorage` key is introduced. | owner (round-1/answers.json#acceptance; accepted recommendation) | n/a — owner |
| 15 | Other constraints | Any extra behavior, copy or constraint? | Left blank (optional question). No additional constraint. | owner (round-1/answers.json#other-constraints, `unanswered`, optional) | n/a — owner |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Collapse state and toggle in `BacklogTray` | In this change | Core feature; owner chose the tray, session-only state, and the header-button pattern. |
| Positive-`useState` default expanded + list unmounted when collapsed | In this change | Required by decisions 2, 5 and 8; unmounting is safe only because collapse is blocked while editing. |
| Header copy swap when collapsed | In this change | Decision 7. Expanded copy (including the archived variant) is unchanged. |
| New Playwright spec | In this change | Decision 14; there is no DOM/component test harness, so e2e is the only layer that can see the disclosure and the reclaimed height. |
| `docs/architecture/messages-backlog.md` update | In this change | Decision 14; it is the tray's contract document. |
| Persisting the collapse choice across sessions/tasks | Out of scope | Owner explicitly chose session-only (round-1#persistence, overrode the recommendation). A later ticket can add a `panel-collapse.ts` key if the reset proves annoying. |
| Per-task collapse memory | Out of scope | Same owner decision; not a deferral by the agent. |
| Auto-collapse above a count | Out of scope | Owner chose default-expanded; the threshold question is not applicable. |
| Per-message collapse / expand-all / collapse-all | Out of scope | Owner confirmed non-goals (round-1#non-goals). |
| Virtualization for a very large backlog | Out of scope | Owner confirmed non-goals; the list stays capped and scrolls. A genuine render-cost problem is a separate ticket. |
| Backend/preference sync, Settings toggle, keyboard shortcut | Out of scope | Owner confirmed non-goals; collapse is chrome, and `CLAUDE.md:175` keeps chrome out of the preferences API. |
| Existing data backfill | None needed | `task.backlog` is untouched; collapse state is not task data. |
| `CLAUDE.md:175` / `panel-collapse.ts` change | Not needed | No new `localStorage` key under the chosen session-only persistence. |

## Assumptions still open

- **The collapsed list is unmounted, not hidden.** This follows from decision 5: with `editingId === null` there is no row-local draft to preserve, so unmounting avoids the `data-popover-open` Escape trap entirely and saves render cost. If a later requirement allows collapsing mid-edit, this must be revisited.
- **Collapsed hint copy** is `saved messages — expand to review`. If the owner wants different wording, it is a one-string change with no structural impact.
- **The toggle is rendered as a real `<button>`** even though the tray's header currently has no interactive element; the header `div` is replaced, not wrapped, so no button is nested inside another.
- **The e2e height assertion** will compare the transcript scroller's bounding box (or the tray's) before and after the toggle. The exact measurement helper is a planning detail; the acceptance is that the transcript grows by roughly the tray's freed height.
- **No feature flag / rollout step.** The change is local UI in one component; a revert is a code revert with no data implications.
