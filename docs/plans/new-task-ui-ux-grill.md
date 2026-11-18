# Grill: New Task panel and Git launch dialogs redesign

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Pipeline task text plus the owner's screenshot (outside the repo); investigation brief `docs/plans/new-task-ui-ux-investigation.md` |
| Mode | Interactive via the decision form, answered by the owner in 2 rounds. The round-1 server stopped before writing its file, so the owner pasted the submitted JSON in chat and it was saved verbatim as `round-1/answers.json`, without the server's `summary`/`specSha256` block. Round 2 was submitted through the server. |
| Answers | `docs/plans/new-task-ui-ux-grill/round-1/answers.json`, `docs/plans/new-task-ui-ux-grill/round-2/answers.json` |
| Flags | none |
| Spec | None outside this record: **this record is the contract.** The style spec it requires (D-A2) is written during the build under `docs/architecture/`. |

No one-way doors. The change is webview-only: no route, migration, server behavior or public contract changes. The create payload is unchanged apart from the Speed fix (D-B1).

## Decisions

### Scope and architecture
| # | Question | Answer | Source |
| --- | --- | --- | --- |
| S1 | Surfaces in scope | The New Task panel, "Work on this with Agetor" (issue), "Resolve with Agetor" (PR conflicts), **Select projects**, **Branch naming**, **Clone → "Explain this repository"**, **Settings → Agents** (agent profile form), and the **RunPanel send box** (see S2) | owner (round-1/answers.json#surfaces; accepted the recommendation and also ticked `runpanel-full`, resolved in S2) |
| S2 | RunPanel send box depth | **Full redesign in this change**: the dock, its toolbar actions (Save for later, Commit & push, Resolve conflicts, Send) and the read-only "Viewing a background agent" bar adopt the new pattern. The send-box screenshots become before/after pairs | owner (round-2/answers.json#runpanel-scope; accepted recommendation) |
| S3 | One launch picker | `NewTaskForm` moves onto the shared `useTaskLaunch` + `TaskLaunchPickers` (redesigned). The panel and every dialog use the one component. The panel's local launch state (about 450 lines: `agentCache`, seed effects, `switchAgent`, the JSX at `:917-1247`) is deleted. Its hidden behaviors (per-kind cache, pending seeds for catalog-only models, `modelTouched`, stale profile/pipeline guards m19, `effectiveStatus` vs `selectedStatus` F2-3, the gemini overage check on the pipeline start step L-A8) move into the hook, **each pinned by a test before the move** | owner (round-1#unify; accepted recommendation) |
| S4 | Drifted behaviors that every surface gets | **All of them**: model refresh ↻; the three-state status dot (green / amber when logged out / red); the harness tooltip with account email + today's token burn; the unavailable / not-logged-in hint directly under the harness picker; the Fable/Mythos "2x usage" notes; switching harness restores that harness's previous picks (per-kind cache); remembered Speed and Max Mode per harness (`lastSpeed` / `lastMaxMode:<kind>`) in the dialogs too; the pipeline runnability preflight (`resolvePipelineLaunch`) blocking Run with a reason in the panel; pipeline loading/error/empty hints; the "Manage agents…" row in the dialogs' Agent picker | owner (round-1#drift-winners; accepted recommendation) |
| S5 | Gate Run on harness availability (behavior change) | In the panel, **Run task** is disabled with a reason while the selected harness is unavailable. **Add to backlog** stays enabled. This matches the dialogs' `effectiveLaunchable` | owner (round-1#drift-winners `gate-run`; accepted recommendation) |
| S6 | Mode control | A **Code \| Plan segmented control** (one click to Plan, the per-harness Plan tooltips kept). Under Code, a variant picker with hints (Auto / Accept edits / Ask…), shown only when the harness has more than one Code variant. The old second Mode select is removed | owner (round-1#mode-control; accepted recommendation) |
| S7 | Where Mode sits | The segmented control is **always visible** in the Agent section, under Harness. Only the variant picker goes behind the Agent section's "More options" | owner (round-2#mode-placement; accepted recommendation) |

### Layout and information architecture
| # | Question | Answer | Source |
| --- | --- | --- | --- |
| L1 | How the form is organised | Three labelled sections: **Task** (Type, Title, Prompt with the Extensions picker, Files), **Workspace** (Projects, Branch rows, Isolate, Branch name), **Agent** (Pipeline, Agent profile, Harness, Mode, Model, Effort, Speed, Max Mode) | owner (round-1#ia `sections-summary`; accepted recommendation) |
| L2 | Collapse model | **Two levels.** (a) Workspace and Agent can each collapse to a one-line summary (e.g. `agetor · fix/7c5261 · isolated`, `Claude Code · Opus 5.5 · High · Code`) that expands on click. (b) Inside an open section, the rarely changed fields sit behind a **More options** disclosure. Both states are remembered in localStorage (new `agetor:*` keys in `lib/panel-collapse.ts`, read synchronously on first render). Frequent fields are never behind More options | owner (round-2#collapse-model `both`; accepted recommendation) |
| L3 | Frequent fields (always visible when a section is open) | Type, Title, Prompt, Files, **Project, Isolate, Pipeline, Harness, Model, Effort**, plus the Mode segmented control (S7) | owner (round-1#frequent-fields, with no recommendation accepted as-is: the owner added Isolate, Model and Effort and removed Mode from the guess) |
| L4 | Rare fields (behind More options) | Workspace: **Branch name** (with its gear / Reset to pattern). Agent: **Agent profile**, the **Mode variant**, **Speed**, **Max Mode**. Extensions (MCP · Skills · Plugins · Agents · Prompts) stays where it is, in the Prompt label row | derived from L2 + L3 + S7 (owner answers) |
| L5 | Harness picker | A **searchable picker** in the same family as Agent and Pipeline. Its rows show icon, full name, stack chip, status dot and account email; the trigger shows the current choice. The 2-column button grid is removed | owner (round-1#harness-picker; accepted recommendation) |
| L6 | Panel width | **Resizable** with a drag handle: default 384 px, min 320, max 560, width remembered in localStorage | owner (round-1#panel-width; accepted recommendation) |
| L7 | Issue and PR-conflict dialog layout | **Two columns** at about `max-w-4xl`. Left: issue/PR context, Type, Prompt, Files. Right: the Workspace and Agent sections (same components and collapse model as the panel). **Sticky footer**. One column below about 768 px | owner (round-1#dialog-layout; accepted recommendation) |
| L8 | Panel form factor | Stays a left sidebar: always mounted, collapsible to its `w-11` rail, an aside-wide drop zone (not armed while collapsed), the onboarding spotlight target (`focusNonce`). The `Branch · <project>` summary becomes a visibly clickable row. "Reset to pattern" and the pipeline card's "Change" become small ghost buttons | owner (round-1#sidebar-stays; confirmed default) |

### Visual language
| # | Question | Answer | Source |
| --- | --- | --- | --- |
| V1 | Selected state | **Subtle**: accent background + primary ring/border + normal text. Solid primary is reserved for the main action (Run task). Checked in both themes | owner (round-1#selected-style; accepted recommendation) |
| V2 | Dropdowns | **One custom picker family** (built from `SearchSelect`) for Mode variant, Model, Effort, Harness, Agent and Pipeline. No native `<select>` in these surfaces. Every popover follows the `data-popover-open` Escape contract and portals when `fixed` | owner (round-1#dropdown-family; accepted recommendation) |
| V3 | Control size | One size for every field and toggle in these surfaces: **`h-9`, `text-sm`** (the primitives' default), with no per-site overrides | owner (round-1#control-size; confirmed default) |
| V4 | Small text | New rem-based tokens **`text-2xs` = 0.6875rem** and **`text-3xs` = 0.625rem** in `tailwind.config.js`, used in the in-scope files so helper text follows Cmd+/− | owner (round-1#text-tokens; confirmed default) |
| V5 | Isolate control | The native checkbox is replaced by the hand-rolled `Switch` (as Max Mode uses), with an associated label. `data-testid="isolate-toggle"` is kept. This also covers the locked variant (`WorktreeOptions.tsx:297`) | owner (round-1#isolate-control; confirmed default) |
| V6 | Dialog chrome | Add `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogBody` / `DialogFooter` to `ui/dialog.tsx` and adopt them in every in-scope dialog | owner (round-1#dialog-parts; confirmed default) |
| V7 | Labels | Every control gets an associated label (a new hand-written Field/Label primitive in shadcn's shape, with `htmlFor`/`id` and `role="group"` for groups) | owner (round-1#acceptance `a11y`) |

### Bugs, copy, keyboard
| # | Question | Answer | Source |
| --- | --- | --- | --- |
| B1 | Fast speed dropped for claude-code/codex (`NewTaskForm.tsx:724`) | **Fix**, and add an e2e that submits from the form and asserts the stored speed | owner (round-1#bugs; accepted recommendation) |
| B2 | False `@author` warning in the issue dialog | **Fix in the composer**: the unresolved-`@` warning ignores `@tokens` that don't look like paths (no `/`, no `.`, matching a GitHub login pattern). The issue prompt text and `agetor add --issue` stay unchanged | owner (round-1#bugs + #author-fix; accepted recommendation) |
| B3 | Stale `TaskLaunchPickers` header comment | **Fix** | owner (round-1#bugs; accepted recommendation) |
| C1 | Action labels | Primary **Run task** everywhere. Panel secondary: **Add to backlog** (was "To backlog"). Dialogs: **Cancel** + **Run task** (was "Create & start"). The dialogs gain no backlog action | owner (round-1#cta; accepted recommendation) |
| C2 | Keyboard submit | **Cmd/Ctrl+Enter** triggers Run task in the panel and in every in-scope dialog, shown as a hint on the button. It is inert while a popover or autocomplete is open, and does nothing when Run is disabled. In the RunPanel send box (S2) it keeps whatever key sends today; the plan confirms that parity and does not change send behavior | owner (round-1#cmd-enter; confirmed default) + S2 |
| C3 | Panel header CLI version | **Removed**. The version stays in the harness picker row's tooltip | owner (round-1#header-version; confirmed default) |

### Process and acceptance
| # | Question | Answer | Source |
| --- | --- | --- | --- |
| P1 | Shared primitives and tokens versus the peer UI branches (App bar, TaskCard, file chip) | This branch adds new primitives and tokens **additively**: new files and new tokens only, with no edits to existing primitives' defaults. They are announced to the peers over JubarteAI | owner (round-1#peer-primitives; accepted recommendation) |
| P2 | e2e churn | Update the ~15 affected specs in the same change. Move DOM-path XPath locators (Model, Effort, Mode) to stable test ids, unifying `new-task-*` / `launch-*` under one prefix (e.g. `launch-model-picker`). Keep the accessible names the e2e asserts, except where C1 renames them | owner (round-1#e2e-churn; confirmed default) |
| P3 | Done means | (1) Before/after screenshots of **every** in-scope surface in **both themes**, attached to the PR. (2) A committed component and style spec under `docs/architecture/` (sections, control sizes, spacing, selected/disabled/error states, which picker for what). (3) Accessibility: associated labels, the whole form works by keyboard (Tab order, Escape contract), visible focus, AA contrast in both themes. (4) The full e2e suite green after locator migration, plus new e2e for the form-submit Speed (B1), Cmd/Ctrl+Enter (C2), and section collapse / More options persistence (L2). (5) RunPanel send-box screenshots (before/after, per S2) | owner (round-1#acceptance; accepted recommendation) |

## Completeness dispositions
| Item | Disposition | Owner or reason |
| --- | --- | --- |
| NewTaskForm's local launch state and duplicated JSX | in this change (deleted after S3) | owner, S3 |
| The 4 `TaskLaunchPickers` consumers (issue, PR conflicts, Clone, Settings → Agents) | in this change | owner, S1 |
| The 4 `PromptComposer` consumers (panel, issue, PR conflicts, RunPanel) | in this change | owner, S1/S2 |
| `AgentProfilePicker` / `PipelinePicker` in `pipelines/StepPanel.tsx:156,263` | in this change only through shared primitive changes (they inherit the picker-family trigger style); no StepPanel layout redesign | Different surface (the pipeline editor), not a task launch. A layout redesign there would be a different ticket |
| `SpeedPicker` in RunPanel task details (`task-speed`) | in this change through shared primitives; no layout redesign of task details | Task details is not the send box; a different ticket |
| `StackPositionChip` / `AgentIcon` (shared with App bar and TaskCard) | unchanged defaults; used as-is in the new harness picker | P1, additive only, to avoid colliding with the peer branches |
| Docs describing current behavior: `prompt-composer.md`, `issue-tasks.md`, `harnesses.md:30-34`, `agent-profiles.md:41-42`, `pipelines.md:151-155`, `clone-repository.md:61-62`, `multi-repo-tasks.md`, `harness-stacks.md:1871`, CLAUDE.md "UI conventions" (new tokens, primitives, the picker family) | in this change | Repo rule: update docs with the behavior |
| The new style spec doc under `docs/architecture/` + a Topic map row in CLAUDE.md | in this change | owner, P3 |
| e2e locator migration (~15 specs) + new specs (B1, C2, L2) | in this change | owner, P2/P3 |
| App-wide `text-[11px]`/`text-[10px]` (about 490 uses outside these files) moved to the new tokens | out of scope | owner (round-1#text-tokens): a separate sweep, a different ticket |
| Other dialogs adopting the Dialog parts | out of scope | owner (round-1#dialog-parts): adopted when touched, a different ticket |
| The dialogs getting an "Add to backlog" action | out of scope | owner (round-1#cta chose `run-task`, not `run-task-backlog-dialogs`) |

## Assumptions still open
- **Round-1 integrity.** The round-1 answers were pasted from the owner's submitted JSON, because the server stopped first. That file has no server `summary`/`specSha256`. Assumed identical to what the form submitted. If not, the owner re-answers round 1.
- **More options membership (L4)** is derived from the owner's frequent-fields list. If the owner changes Branch name or the Agent profile often in practice, those fields move out of More options. That is a one-line change to the section config, not a plan shape change.
- **Dialog breakpoint (L7)**: about 768 px for the two-column → one-column switch, and about `max-w-4xl`. These are the plan's numbers to pin. If the WKWebView window minimum makes them moot, the plan adjusts them.
- **RunPanel send key (C2)**: Cmd/Ctrl+Enter in the send box keeps today's send behavior. If the plan finds a conflict, it brings it back as a question rather than changing send semantics silently.
- **Peer coordination (P1)**: additive-only assumes the peer branches don't also add same-named tokens (`text-2xs`). The plan checks the peer branches' diffs before merging.
