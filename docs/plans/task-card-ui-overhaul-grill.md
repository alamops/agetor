# Grill — Task card UI overhaul

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Owner goal ("Improve the Card UI following the best UI/UX practices. Currently it's broken like in the attached screenshot") + screenshot (outside the repo; transcribed in §0 of the brief) + `docs/plans/task-card-ui-overhaul-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds |
| Answers | `docs/plans/task-card-ui-overhaul-grill/round-1/answers.json`, `docs/plans/task-card-ui-overhaul-grill/round-2/answers.json` |
| Flags | none |
| Spec | No PRD. The goal and screenshot live outside the repo (a Desktop file attached to the pipeline task). This record and the investigation brief's §0 are the in-repo contract; the plan must restate the acceptance bar. |

No one-way doors: every change is rendering-only plus one pure shared function. There is no DB, route or migration change.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Scope | Fix only or redesign? | **Full redesign**: every breakage plus header, action row, preview, chips, button sizes, a11y and density. | owner, accepted recommendation (round-1#scope) |
| 2 | Process | Visual sign-off before code? | **Yes.** Planning publishes an HTML mockup before coding (see #3 for its shape). | owner, accepted recommendation (round-1#mockup) |
| 3 | Process / header | Header layout | Round 1: the owner rejected all three fixed layouts: *"We actually need to follow the best practices and try some designs to make sure the new one won't have the 'breaking' issue."* Round 2 settled it: **Planning publishes 2–3 whole-card alternatives.** Each is rendered at the real 262 px card width with worst-case content (26-char pipeline name, 25-char profile, stack chip, every count badge, 128-char unclamped title, `Answer (12)`), in every card state, light and dark. Each is checked automatically (every child inside the card box, no overlaps) and shows pass/fail per state. **The owner picks one** before code. My meta-footer layout (`model · mode` folded into a bottom meta block with repo · branch) is one alternative, not the decision. The 2026-09-01 3-row header (`docs/plans/task-card-header-rows.md`) is open again and is superseded by whichever layout wins. | owner (round-1#header-layout "other"; round-2#design-process, accepted recommendation) |
| 4 | Pipeline | How is the pipeline shown on its card? | Round 1 picked "name truncates, active step on its own line", but the owner's note added: *"We need full name been seen. We can even have it as a sub card to the main card. Or a special 'hat' in the UI when the card is a pipeline."* Round 2: **a pipeline "hat"**, a full-width band at the top of the card, tinted by run status. It holds `⧉` + the **full pipeline name (wraps, never truncated)** and the progress (`3/10` / `✓ Done`, never truncated) on the right. The active step or pending gate line sits at the bottom of the hat. Row 1 below keeps only the type icon, count badges and stack chip. | owner (round-1#pipeline-pill + note; round-2#pipeline-name, accepted recommendation) |
| 5 | Title | Clamp long titles? | **Keep the full wrap** (the 2026-09-01 decision stands). No clamp; the mockup's worst case uses a 128-char title. | owner, overrode the clamp-3 recommendation (round-1#title-clamp) |
| 6 | Progress | What does `n/total` mean with loops and branches? | **Distinct completed steps / total.** A finished (`done`) run reads **`✓ Done`**. Failed or cancelled runs show distinct `n/total` in the status colour, as today. This changes `pipelineStepProgress` in `src/shared/pipeline.ts`, so the board, run view, `agetor ls/show/pipeline` and the TUI all switch at once. | owner, accepted recommendation (round-1#progress-semantics) |
| 7 | Progress | Where does the execution/loop count still appear? | The board pill (hat) **tooltip**, the **pipeline run-view header**, and **`agetor show` / `agetor pipeline`** output (e.g. "13 step runs · 2 loops"). | owner, accepted recommendation (round-1#exec-count) |
| 8 | Actions | How does the action row fit? | **Primary only + `⋯`.** `⋯` opens the existing context menu (`buildTaskContextMenu`) at the button. **Diff moves into the menu** as well, along with Archive, Unarchive, Stop-extra and Delete…. | owner, overrode primary+Diff+⋯ (round-1#action-row) |
| 9 | Actions | Buttons per state | backlog/ready: `Run` · ⋯ — running: `Stop` (destructive, as today) · ⋯ — awaiting: `Answer (N) →` · ⋯ — review: `Open` · `✓ Done` · ⋯ — done/archived: `Open` · ⋯ — **gate pending: `Review` · `Open` · ⋯, with Stop in the menu.** This **supersedes** the earlier pipeline-gate decision ("Stop stays visible as a secondary danger action", `TaskCard.tsx:395-399` comment). | owner, accepted recommendation (round-2#action-states) |
| 10 | Preview | What does the 2-line preview show? | **The first prose paragraph as plain text.** Skip headings, tables, rules, code fences and front-matter-like blocks; strip emphasis and link syntax. If no prose remains, fall back to the stripped text; if that is empty, show no preview line. Persisted prompts stay raw. | owner, accepted recommendation (round-1#preview) |
| 11 | A11y | Which items are in? | **All five:** a `focus-visible` ring (semantic `ring` token); keyboard open; the card's role becomes a labelled group instead of `button`, keeping whole-surface pointer drag; `aria-label` on every icon-only button; **keyboard dragging between columns (`KeyboardSensor`) is in.** | owner, overrode the recommendation (keyboard drag added) (round-1#a11y-items, round-1#keyboard-drag-disposition = "in") |
| 12 | A11y | Keyboard keys (Enter/Space collided with dnd-kit's defaults) | **Enter opens; Space picks up and drops; ← → move between columns; Esc cancels.** Screen-reader announcements use dnd-kit's live region with our own wording. A keyboard drop goes through the same `onDragEnd` (`App.tsx:2068`), so the pipeline-parent refusal and the 409 re-sync apply unchanged. There is no in-column ordering. | owner, accepted recommendation (round-2#keyboard-keys); drop path from evidence `App.tsx:2079` |
| 13 | Look | Density and consistency | **All four:** one chip system (`h-5`, `text-[10px]`, `rounded-full`, same padding, colour carries the meaning); one button height `h-7` for text and icon buttons; card padding `p-4` → `p-3` (content 225 → 233 px); workdir + branch on one line as `repo folder name · branch`, with the full path and branch in the tooltip. | owner, accepted recommendation (round-1#density) |
| 14 | Acceptance | What must pass? | **All five:** (a) an e2e bounds spec: every child of the card stays inside the card box, for every state (pipeline hat + profile + stack + long names; gate pending; awaiting `Answer (12)`; all count badges); (b) unit tests for progress with a loop history (repeated stepIds), an untaken branch and done/failed/cancelled runs, with the CLI `ls`/`show` tests updated; (c) unit tests for the markdown-to-preview helper (headings, tables, fences, emphasis, links, empty); (d) screenshots of the card states in light and dark attached to the PR; (e) **the owner checks it by eye in `bun run dev:hmr` before merge.** | owner, overrode the recommendation (added the owner check) (round-1#verification) |
| 15 | Guardrail | Rule against re-breaking the card | **A short rule in CLAUDE.md's *Webview* rules, plus a new `docs/architecture/task-card.md` and a Topic map row.** The doc holds the layout contract: the 262 px card / 233 px content budget, no `shrink-0` on a variable-length chip, the per-state button table, the hat, and the e2e bounds spec and how to run it. Rule text (proposed): "A TaskCard change must keep every child inside the card in every state. Run `e2e/task-card-bounds.spec.ts` before merging." The owner's note named "Claude or Agents MD"; the repo has no `AGENTS.md`. | owner (round-1#header-layout note; round-2#card-rule, accepted recommendation) |
| 16 | Confirm | Answer button colour | Replace `bg-amber-500 text-amber-950 …` with `bg-warning-solid` plus a new `--warning-solid-foreground` token, added to both themes in `index.css` and to `tailwind.config.js`. Card-local; the shared awaiting ring/glow and `StepNode` look stay unchanged. | owner, accepted recommendation (round-1#amber) |
| 17 | Confirm | Dark-mode Done hole | Card-local `bg-transparent` on the outline `Done`; the shared Button variant is not changed. | owner, accepted recommendation (round-1#done-dark) |
| 18 | Confirm | Clipping | No `overflow-hidden` on the card: fix the flex layout instead, so the unread dot and awaiting glow are never clipped. | owner, accepted recommendation (round-1#no-overflow-hidden) |
| 19 | Confirm | Column width | Columns stay `w-72`. | owner, accepted recommendation (round-1#column-width) |
| 20 | Confirm | Shared primitives | `ui/badge`, `ui/button` and `ui/card` variants are not changed; use card-local classes or a new card-only chip component. | owner, accepted recommendation (round-1#primitives) |
| 21 | Confirm | Preview helper location | `src/mainview/lib/prompt-preview.ts` + a sibling test. | owner, accepted recommendation (round-1#preview-helper-home) |
| 22 | Confirm | Docs | Update `task-context-menu.md` (card ↔ menu precedence, the `⋯` entry), `pipelines.md` (progress rule, hat), the `PipelineBadge` doc comment and the header e2e spec comment; add a "superseded by" note to `docs/plans/task-card-header-rows.md`. Also the new `task-card.md` (#15). | owner, accepted recommendation (round-1#docs) |
| 23 | Confirm | Mobile companion card | Out of scope: desktop webview card only. | owner, accepted recommendation (round-1#mobile) |
| — | Acceptance | Anything else for "done"? | Optional, left blank. | round-1#done-means |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Header overflow (`shrink-0` on PipelineBadge/profile/StackBadge) | in this change | owner (#1) |
| `13/10` over-count in `pipelineStepProgress` and every consumer (board, `PipelineRunView.tsx:525,967`, `cli/commands/pipeline.ts:577`, `show.ts:165`, `ls.ts:221`, `tui/Dashboard.tsx:779,911`) | in this change | owner (#6, #7) |
| Gate-pending and awaiting action-row overflow | in this change (Primary + ⋯) | owner (#8, #9) |
| Dark Done hole, amber literal | in this change | owner (#16, #17) |
| Raw-markdown preview | in this change | owner (#10) |
| Five chip styles, 4 px button mismatch, padding, two meta lines | in this change | owner (#13) |
| Focus ring, keyboard open, nested-interactive, icon aria-labels | in this change | owner (#11) |
| Keyboard dragging (`KeyboardSensor` in `App.tsx:397`) | in this change | owner (#11, #12) |
| Context-menu precedence mirror (`task-context-menu.ts` + its test) | in this change: `⋯` reuses it, and the menu must carry every action removed from the card (Diff, Archive, Unarchive, Stop, Delete…) | evidence (brief §1, §7) |
| `Column.tsx` memo comparator / `App.tsx` `useCallback`s for any new callback prop | in this change if a prop is added; the existing `onContextMenu(task, pos)` should serve `⋯` | evidence (brief §5) |
| e2e selectors that move: `getByTitle("View changes (git diff)")` (2 specs), `button[title="Stop"]` (`pipelines-human-step`), the `task-card-pipeline-stop` test id, the `task-card-header.spec` geometry, `.cursor-grab` root locator (~20 specs) if the root changes | in this change (retarget together) | evidence (brief §5) |
| `StackBadge.test.tsx` class assertions, `pipeline.test.ts`, `mainview/lib/pipelines.test.ts:1695`, `cli/show.test.ts`, `cli/ls.test.ts`, `task-context-menu.test.ts` | in this change | evidence (brief §5) |
| Docs (#22) + `task-card.md` + CLAUDE.md rule + Topic map row | in this change | owner (#15, #22) |
| Mobile companion card | out of scope: a separate codebase and layout | owner (#23) |
| Wider or resizable columns | out of scope: a different ticket (Column/App layout) | owner (#19) |
| Agent-written prompt summary (server field) | out of scope: a server feature; the preview stays a client-side transform | evidence (brief §3) |
| Data backfill | none needed: rendering-only; progress is recomputed from the existing `history` | evidence (brief §5) |

## Assumptions still open

- **WKWebView lays out the flex rules like Chromium.** The e2e and mockup measurements run in Chromium. If WKWebView differs, the owner's dev-build check (#14e) is the backstop.
- **The hat and the unread dot / awaiting glow coexist.** The hat sits at the card's top edge, where the unread corner dot is today. The mockup must show the dot's placement on a pipeline card; if it collides, the dot moves, which the owner sees at mockup sign-off.
- **The mockup layout pick (#3) is still to come**, at the design sign-off gate in Planning. Everything in this record holds for every alternative: the hat, Primary + ⋯, full-wrap title, chip system, `p-3` and the meta line are constraints the alternatives must all respect, not variables.
- **A keyboard drag starting on a pipeline parent** follows the existing refusal toast (the same `onDragEnd`). If that feels wrong by keyboard, it's a wording change only.
