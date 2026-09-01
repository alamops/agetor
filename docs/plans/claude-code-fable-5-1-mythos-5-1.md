# Plan — Fable 5.1 + Mythos 5.1 in the Claude Code model list (+ Cursor Fable 5.1)

| Field | Value |
| --- | --- |
| Date | 2026-09-01 |
| Source | /implement "add Fable 5.1 and Mythos 5.1 in Claude Code list" (agetor task) |
| Config | AGENTS_CONFIG.yml (balanced preset) |
| Flags | none |
| Gates | Grill answered by owner (4 questions, all resolved); plan approval pending |
| Branch | feature/add-fable-5-1-and-mythos-5-1 |
| Base SHA | e2d95dfa9f07d39bc8e6d5781b17788711ffdd8c (tree clean) |

## 1. Objective & success criteria

Add Claude **Fable 5.1** and **Mythos 5.1** as selectable claude-code models, and Fable 5.1 to the Cursor catalog. Done means: both rows render in every picker (New Task, task details, launch dialogs, CLI), a run launched with them passes the correct `--model claude-fable-5-1` / `--model claude-mythos-5-1` argv, effort picker offers the full low→max ladder, the live-session `/model` mirror drives the Fable family row for `fable-5.1`, claude's `Set model to Fable 5.1` stdout syncs back to the task row, the Cursor picker offers Fable 5.1 with working effort/max-mode composition, `bun run typecheck` green, `bun test` green, and the claude-picker e2e assertion (self-derived from AGENT_OPTIONS) passes.

## 2. Context & constraints (grounded findings)

- **Model identities** (claude-api skill, cached 2026-06-24): Fable 5.1 = `claude-fable-5-1`, successor to Fable 5 (still served), same tier/price ($10/$50 = 2x Opus). Mythos 5.1 = `claude-mythos-5-1`, Project Glasswing only, same capabilities/pricing as Fable 5.1. Both support effort `low/medium/high/xhigh/max`.
- **Id convention**: curated friendly ids use dots (`opus-4.8`), CLI flags use dashes (`claude-opus-4-8`) — so friendly ids are **`fable-5.1` / `mythos-5.1`**, flags `claude-fable-5-1` / `claude-mythos-5-1` (`CLAUDE_MODEL_FLAG`, src/bun/agents.ts:140-150). Labels: "Fable 5.1" / "Mythos 5.1" (no "Claude" prefix).
- **Curated list**: `AGENT_OPTIONS["claude-code"].models` (src/shared/types.ts:1897-1908), family-grouped, newest first within family, default (`opus-5`) not index 0. No `catalogOnly` gating for claude-code.
- **Load-bearing translation**: without a `CLAUDE_MODEL_FLAG` entry, `toClaudeModelArg` passes `fable-5.1` through verbatim → wrong argv. The inverse `claudeModelIdFromArg` (agents.ts:177-182) and display-name resolution (`claudeModelIdFromDisplayName`, src/bun/claude-local-setting.ts:69-86) are generic once the entries/labels exist; the word-boundary guard already prevents "Fable 5.1" being rounded to `fable-5`.
- **Picker-family mirror**: `claudeModelPickerFamily` (agents.ts:202-215) is an exact-id switch; only the *current* release per family owns a case (Opus precedent: `opus-5` yes, `opus-4.8/4.7/4.6` null). Probe: installed claude CLI 2.1.257 bundles `claude-fable-5-1` (23 occurrences). Wrong-row risk is self-correcting: a mirror's outcome syncs from claude's own `Set model to …` stdout (viaMirror attribution).
- **Effort/mode maps**: `MODEL_EFFORT_SUPPORT["claude-code"]` (types.ts:1761-1777) and `MODEL_MODE_DENY["claude-code"]` (types.ts:1866-1877) list every id explicitly. Unknown ids silently inherit `opus-5`'s sets — explicit entries required for correctness/documentation.
- **Cursor catalog (measured 2026-09-01, `cursor-agent models`, 218 rows)**: `claude-fable-5-1-{low,medium,high,xhigh,max}` + `-thinking-*` variants exist, display "Claude Fable 5.1 1M … (NO ZDR)"; **no `-fast` fable variants; no Mythos ids at all**. `AGENT_OPTIONS.cursor.models` (types.ts:1939) and `MODEL_EFFORT_SUPPORT.cursor` (types.ts:1789-1794) derive from `CURSOR_MODEL_SPECS`, so one spec entry covers picker + efforts + `cursorModelArg` + `cursorModelIdCoveredByCatalog`.
- **Generic by construction (no edits)**: claude-local-setting.ts, model-options.ts/`mergeModelOptions`, agent-discovery, RunPanel/TaskLaunchPickers/CLI pickers, server effort validation, e2e/fx-models.spec.ts (derives expected labels from AGENT_OPTIONS).

## 3. Approach & key decisions (owner-confirmed)

1. **Coexist, not replace** (owner): add 5.1 rows; keep Fable 5 / Mythos 5 rows (Opus precedent). Old rows' hints get "prior release" wording.
2. **`fable-5.1` owns the "Fable" mirror family** (owner): `fable-5` demoted to `null` (next-run breadcrumb), same treatment as `opus-4.8`. Grounded in CLI 2.1.257 evidence + stdout drift-correction safety net. `mythos-5.1` → `null` like `mythos-5` (claude's picker has no Mythos row).
3. **Default stays `opus-5`** (owner): premium 2x-usage tiers remain opt-in.
4. **Cursor Fable 5.1 in scope** (owner), grounded in the measured catalog: mirror the `claude-fable-5` spec (non-thinking effort ids, `supportsMaxMode: true`, **no** `fastEfforts`). No Cursor Mythos (not in catalog — evidence-based exclusion).
5. NewTaskForm's exact-id cost/access callouts generalize to family checks so future point releases don't need new blocks.

## 4. Work breakdown — implementation tasks

**T1 — shared catalogs** (`src/shared/types.ts` only)
- `AGENT_OPTIONS["claude-code"].models`: insert `mythos-5.1` and `fable-5.1` rows at the top (order: Mythos 5.1, Mythos 5, Fable 5.1, Fable 5, Opus 5, … — family-grouped, newest first). Hints follow existing style; old rows reworded as prior releases (e.g. Fable 5 → "Prior Fable release …", Mythos 5 hint points at Fable 5).
  - `fable-5.1`: "Most capable widely released model — above Opus. Uses 2x the usage of Opus."
  - `mythos-5.1`: "Fable 5.1's twin — same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus."
- `MODEL_EFFORT_SUPPORT["claude-code"]`: add `"mythos-5.1"` / `"fable-5.1"` → `["max","xhigh","high","medium","low"]`, above the 5.0 entries; update the enumerating doc comments (types.ts:1754-1757, 1762-1764).
- `MODEL_MODE_DENY["claude-code"]`: add both ids → `[]`.
- `EFFORT_OPTIONS` xhigh hint (types.ts:1729): include the 5.1 generation.
- `CURSOR_MODEL_SPECS`: add `"claude-fable-5-1"` immediately before `"claude-fable-5"` (types.ts:1459): label "Fable 5.1", hint "Anthropic Fable 5.1 via Cursor.", `supportsMaxMode: true`, `effortIds: {max/xhigh/high/medium/low → claude-fable-5-1-<effort>}`, no `fastEfforts` (measured: no -fast variants). Acceptance: typecheck green; derived cursor efforts pick up the entry.

**T2 — bun driver mapping** (`src/bun/agents.ts` + one comment in `src/bun/orchestrator.ts`)
- `CLAUDE_MODEL_FLAG`: add `"mythos-5.1": "claude-mythos-5-1"` and `"fable-5.1": "claude-fable-5-1"` at the top.
- `claudeModelPickerFamily`: `"fable-5.1"` → `"Fable"`; remove the `"fable-5"` case (falls to `null`); update the doc comment (agents.ts:190-197) recording the supersession + CLI 2.1.257 evidence and that `mythos-5.1` joins `mythos-5` in the no-picker-row bucket.
- `src/bun/orchestrator.ts:~1650`: extend the mythos-5 no-row comment to mention `mythos-5.1` and superseded `fable-5`. Acceptance: typecheck green.

**T3 — UI callouts** (`src/mainview/components/kanban/NewTaskForm.tsx:775-789`)
- Generalize `model === "fable-5"` / `model === "mythos-5"` to family checks (`model?.startsWith("fable-")` / `startsWith("mythos-")`), interpolating the selected option's label (e.g. "Fable 5.1 uses 2x the usage of Opus."); mythos keeps the Glasswing sentence. Acceptance: typecheck green; callout renders for all four ids.

## 5. Work breakdown — test tasks

**T4 — driver/catalog tests** (`src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`)
- buildCommand: `fable-5.1` → `--model claude-fable-5-1`; `mythos-5.1` → `--model claude-mythos-5-1` (mirror existing 214-231 cases).
- `claudeModelPickerFamily`: `"fable-5.1"` → `"Fable"`; **update** existing assertion so `"fable-5"` now expects `null`; `"mythos-5.1"` → `null`.
- `claudeModelIdFromArg("claude-fable-5-1")` → `"fable-5.1"` (and mythos analog).
- `supportedEfforts("claude-code", "fable-5.1"/"mythos-5.1")` contain `xhigh` + `max` (mirror 73-83).
- Cursor: `supportedEfforts("cursor","claude-fable-5-1")` full ladder; `cursorModelArg("claude-fable-5-1","xhigh",false)` → `claude-fable-5-1-xhigh`; fast never composes (no fastEfforts); max-mode composition `claude-fable-5-1[context=1m,effort=xhigh]`; `cursorModelIdCoveredByCatalog("claude-fable-5-1-high")` → true.

**T5 — local-setting + mirror tests** (`src/bun/claude-local-setting.test.ts`, `src/bun/orchestrator-paste-withheld.test.ts`)
- Display-name round-trips: `"Fable 5.1"` → `fable-5.1`; `"Fable 5.1 (1M context) …qualifiers"` → `fable-5.1`; `"Fable 5"` still → `fable-5` (no conflation either direction); `"Set model to Fable 5.1 …"` / `"Kept model as Fable 5.1"` parse; mythos analogs.
- `orchestrator-paste-withheld.test.ts:924-943`: the NO_FABLE-pane "target not offered" scenario must switch its task model from `fable-5` (no longer family-mapped, mirror never starts) to `fable-5.1`.

**E2e**: applicable surface already covered by the existing self-deriving spec (`e2e/fx-models.spec.ts:265-282` asserts the rendered claude `<select>` equals AGENT_OPTIONS labels). No new e2e tests; Phase 7 runs that one spec targeted (`bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` — one Playwright run at a time per repo convention). App-start recipe: not needed beyond the Playwright harness (it boots the headless backend itself).

## 6. Execution waves

- Wave 1 (parallel, file-disjoint): T1 ∥ T2 ∥ T3. Barrier: `bun run typecheck`, commit.
- Wave 2 (parallel, file-disjoint): T4 ∥ T5. Barrier: commit.
- Then Phase 5 review (opus) → Phase 7 `bun test` + typecheck + targeted e2e spec → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `task.model` is a free string column — no migration; existing tasks unaffected. PATCH validation reads the maps dynamically.
- Demoting `fable-5` from the mirror family: a mid-session dropdown change to Fable 5 now posts a next-run breadcrumb instead of driving the picker — intended (Opus precedent), and the launch argv path is unchanged.
- If claude 2.1.257's Fable picker row actually still resolves to Fable 5, a `fable-5.1` mid-session mirror lands on Fable 5 and the stdout sync drift-corrects the row + breadcrumbs — degraded UX, no corruption. Next `--model claude-fable-5-1` launch is always correct.
- Cursor: ids measured against the live catalog today; `(NO ZDR)` display suffix is stripped by the generic qualifier logic and irrelevant to id composition.
- Rollback: single revert; no data shape changes.

## 8. Open questions / assumptions

- Assumption: claude's `/model` picker Fable family row on ≥2.1.257 selects Fable 5.1 (evidence: binary bundles `claude-fable-5-1`; not smoke-driven live). Mitigated by stdout drift-correction; worth a one-line release-notes check on the next dogfood run.
- Assumption: Mythos 5.1 effort surface = Fable 5.1 (claude-api skill states same API surface).
- Cursor Mythos excluded — not in the measured catalog (evidence-based, not deferred work).
