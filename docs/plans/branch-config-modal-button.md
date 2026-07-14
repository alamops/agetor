# Plan — Branch config button in the branch name field + realtime-resolved field

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement request (conversation) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/new-project-branch-config-window |
| Base SHA | 7e798f51ef788e5cd69fc25ddcc7d144584be3a9 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (headless run); assumptions in §8 |

## 1. Objective & success criteria

Three user asks:

1. Move the branch-config entry point to an icon button **inside the right side of the branch name field** (replacing the gear button in the New Task form header).
2. The branch name field shows the **resolved branch name, updated in realtime** as the configured pattern, title, task type, and project change.
3. The **configured pattern display and the tags helper message move into the project branch-config modal** opened by that icon button.

Done means: field live-updates while typing a title; clicking the in-field icon opens the config modal; the modal shows each task type's pattern and the tags helper; saving the modal immediately re-resolves the field; typecheck, vite build, and `bun test` green.

## 2. Context & constraints (grounded)

- `src/mainview/components/kanban/NewTaskForm.tsx` — field state: `branchConfig` (l.123), `branchOverride` (l.124, the input value, currently holds the RAW pattern), `branchDirty` (l.125), `branchToken` (l.126, 6-hex), `branchSettingsOpen` (l.127). `computedPattern = branchPattern(branchConfig, taskType)` (l.143-146, deliberately not keyed on title). Re-seed effect l.149-151 (`!branchDirty → setBranchOverride(computedPattern)`). `resolvedBranch = renderBranchTemplate(branchOverride, {title, projectName, taskType, token})` (l.164-172). Validation runs on the resolved name (l.177-180). JSX l.634-677: input, validation error / `→ resolved` preview (l.648-657), Reset-to-pattern button (l.658-666), helper `<p>` from `BRANCH_TEMPLATE_TAGS` (l.667-675). Header gear button l.501-511 (`SlidersHorizontal`). Dialog wiring l.841-846 (`onSaved={(c) => setBranchConfig(c)}`). Submit l.388 sends `branchOverride.trim()` verbatim (raw template).
- `src/mainview/components/settings/BranchNamingDialog.tsx` — per-TaskType prefix inputs + `includeSlug` switch; static example per row via `buildBranchName(config, t.id, "Add login page", {token:"a1b2c3"})`; saves via `PUT /projects/settings`; sole call site is NewTaskForm.
- **Server contract (fleet knowledge, must preserve):** client sends the UNRENDERED template; `orchestrator.createTask` is the authoritative resolver (task-id-derived token + creation-time Date). Rendering client-side at submit would freeze `<timestamp>` and change token semantics.
- In-field trailing icon precedent: `RunPanel.tsx:2535-2554` — relative wrapper, `pr-9` padding, absolute-positioned right icon button.
- No webview component-test harness exists; coverage lives in `src/shared/branch.test.ts`, `src/bun/branch-nomenclature.test.ts`, `src/bun/project-settings-endpoint.test.ts`.

## 3. Approach & key decisions

- **Field value becomes derived, not seeded.** Replace the "seed input with pattern + re-seed effect" model with: when clean, the input displays `renderBranchTemplate(computedPattern, {title, projectName, taskType, token: branchToken})` computed each render — realtime by construction. When dirty, it displays the user's literal `branchOverride`. The re-seed effect (l.149-151) is deleted.
- **Submit:** clean → send `computedPattern` (raw template — server stays authoritative); dirty → send `branchOverride.trim()` verbatim (existing back-compat; server still resolves tags if the user typed any).
- **Pure helper for testability:** extract `branchFieldState({dirty, override, pattern, title, projectName, taskType, token})` → `{ displayValue, submitValue, resolved }` into `src/mainview/lib/branch-field.ts` so the clean/dirty display+submit logic is unit-testable without a DOM harness.
- **In-field button:** wrap the Input in a `relative` div with right padding; absolute icon `Button` (ghost, icon-size, `SlidersHorizontal`) on the right opens `branchSettingsOpen`; same `disabled` condition as today's header button (no workdir). Header button (l.501-511) removed.
- **Form JSX cleanup:** helper `<p>` (l.667-675) removed from the form. The `→ resolved` preview line is kept ONLY for the dirty-with-tags case (`branchDirty && hasBranchTemplateTags(branchOverride)`) — when clean the field itself already shows the resolved name. Reset-to-pattern button kept.
- **Modal gains:** (a) per-row pattern display — `branchPattern(config, t.id)` rendered as code text alongside each type's static example; (b) the tags helper paragraph (generated from `BRANCH_TEMPLATE_TAGS`, never hardcoded) at the bottom; (c) optional `activeTaskType?: TaskType` prop from NewTaskForm to visually highlight the row that drives the current field.
- Alternatives rejected: making the field read-only (regresses #90's override feature); free-form template editing in the modal (schema change + migration, out of scope — noted as future work, consistent with the prior workdone's note).

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | Extract pure field-state helper | `src/mainview/lib/branch-field.ts` (new) | — | Pure, no React imports; handles clean/dirty; unknown tags pass through (delegated to renderBranchTemplate) |
| I2 | Rework NewTaskForm field + in-field config button; remove header gear + helper text; wire helper from I1 | `src/mainview/components/kanban/NewTaskForm.tsx` | I1 | Field realtime-resolves when clean; dirty edit freezes it; Reset restores; submit sends template when clean, literal when dirty; icon button opens dialog |
| I3 | Extend BranchNamingDialog: per-type pattern display, tags helper, activeTaskType highlight | `src/mainview/components/settings/BranchNamingDialog.tsx` | — | Pattern shown per row from `branchPattern`; helper generated from `BRANCH_TEMPLATE_TAGS`; save still echoes config via `onSaved` |

I1+I2+I3 go to **one agent in one wave** — I2 renders I3 and imports I1; splitting a props contract across parallel agents invites drift, and the total surface is small.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| T1 | Unit tests for `branchFieldState` (clean realtime resolution, dirty freeze, submitValue template-vs-literal, empty title fallback, tags-in-override) | `src/mainview/lib/branch-field.test.ts` (new) | I1, I2's submit contract |

No webview component harness exists; UI-level behavior is verified by typecheck + vite build + the existing server/shared suites (unchanged).

## 6. Execution waves

- Wave 1: one implementation agent (I1+I2+I3). Barrier: typecheck + build + commit.
- Phase 5: review agent (opus) on the diff.
- Phase 6: one test agent (T1).
- Phase 7: test-run agent (`bun test` + `bun run typecheck` + vite build).

## 7. Blast radius & risks

- Contained to `NewTaskForm.tsx` internals — investigation confirmed no external reader of the form's in-progress branch value; everything else reads `task.branch` (server-resolved).
- Client preview token ≠ server token (already true today); with the field showing the resolved name, the created branch can differ from the display when patterns use `<token>`/`<timestamp>` — existing rename toast in `App.tsx:645-646` already covers this.
- Deleting the re-seed effect: ensure dirty-reset (`Reset to pattern`) and post-submit reset still leave the field following the pattern (dirty=false ⇒ derived display takes over automatically — simpler than before).
- Server routes, shared helpers, migrations: untouched.

## 8. Open questions / assumptions (autonomous mode)

1. Field remains **editable** with dirty-freeze + Reset (assumed; read-only would regress the override feature).
2. Clean submit sends the **raw template**, not the displayed resolved string (assumed, to honor the server-authoritative contract).
3. "New project branch config modal" = **existing `BranchNamingDialog` extended**, not a second dialog (assumed; avoids duplicating the config surface).
4. Header gear button is **removed**, not duplicated (assumed from "move").
5. Free-form pattern/template editing inside the modal stays out of scope (no schema change).
