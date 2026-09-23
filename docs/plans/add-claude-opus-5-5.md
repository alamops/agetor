# Plan — Claude Opus 5.5 for Claude Code (new default), Cursor and fx

| Field | Value |
| --- | --- |
| Date | 2026-09-22 |
| Source | /implement "Add Opus 5.5 to Claude Code Harnesses and others that support it" (agetor task; refs: anthropic.com/claude-opus-5-5, platform.claude.com/docs/en/models/opus-5-5/{overview,whats-new-opus-5-5,migration-guide}) |
| Config | AGENTS_CONFIG.yml (balanced preset, v1 schema) |
| Flags | none |
| Gates | Grilled + plan approved by owner (2026-09-22) |
| Branch | feature/add-claude-opus-5-5 |
| Base SHA | 6bbe2f8f5257c7e57570c619aabd074afe9fa36c (tree clean) |

## 1. Objective & success criteria

Add **Claude Opus 5.5** (`claude-opus-5-5`, released 2026-09-22) as a selectable model on every harness whose catalog offers it: **claude-code** (curated row, new default), **Cursor** (measured spec + variant-id migration), and **fx** (catalog-gated row). Codex and Gemini don't run Anthropic models — not applicable.

Done means: the row renders in every picker (New Task, task details, launch dialogs, CLI), a claude-code run passes `--model claude-opus-5-5`, the effort picker offers low→max, a mid-session dropdown change to `opus-5.5` drives claude's `/model` Opus row while `opus-5` becomes next-run-only, claude's `Set model to Opus 5.5` stdout syncs back to the row, Cursor composes `claude-opus-5-5-<effort>[-fast]` / `[context=1m,…]`, stored Cursor variant ids are normalized by migration 056, fx offers `anthropic/claude-opus-5.5` when the signed-in catalog contains it, `bun run typecheck` and `bun test` are green, and the two touched e2e specs pass.

## 2. Context & constraints (grounded)

- **Model identity** (docs, 2026-09-22): id `claude-opus-5-5` (fixed, no date suffix); 1M context / 128K output; $4/$20 per MTok, cache reads $0.20 (Opus 5: $5/$25). Successor to Opus 5 (still served). Fable-5.1-level on most work per the announcement. Effort `low|medium|high|xhigh|max`; **API default effort is `medium`** (Opus 5: `high`). **Thinking can't be disabled** — `{type:"disabled"}` and `budget_tokens` both 400; effort is the only control. Forced `tool_choice`, preserved-thinking and `computer_20251124` breaking changes are API-surface only — agetor drives the CLI and never sends those.
- **Agetor's effort plumbing is unaffected by "thinking can't be disabled"**: claude-code effort rides `CLAUDE_CODE_EFFORT_LEVEL` (`src/bun/agents.ts`), the claude-code ladder has no `none`/`minimal` entry, and `DEFAULT_EFFORT["claude-code"] = "high"` is per-kind (`src/shared/types.ts:1862`). Owner decision: keep `high` (grill Q4).
- **claude CLI 2.1.280 (installed)** — *measured*: the binary carries 41 `claude-opus-5-5` occurrences; alias table `opus:"claude-opus-5-5"`, `default:"claude-opus-5-5"`; picker row strings `Opus 5.5 - best for everyday, complex tasks` vs `Opus 5 - previous Opus version`. CHANGELOG 2.1.280: "Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model", plus "an effort level saved before `/effort` became per-model no longer applies to newly released models such as Opus 5.5" (irrelevant to agetor — the env var pins effort at spawn).
- **Picker-family mirror** (`claudeModelPickerFamily`, `src/bun/agents.ts:222`): one row per family, always the family's *current* release. Since 2.1.280's Opus row resolves to 5.5, `opus-5.5` must own `"Opus"` and `opus-5` must drop to `null` — exactly the `fable-5` → `fable-5.1` supersession (`docs/plans/claude-code-fable-5-1-mythos-5-1.md` §3.2). Drift-correction safety net unchanged: a mirror's outcome syncs from claude's own `Set model to …` stdout.
- **claude-code paired structures** (peer checklist, knowledge `660ed97d`): `AGENT_OPTIONS["claude-code"].models` (`types.ts:2646`), `CLAUDE_MODEL_FLAG` (`agents.ts:153`, the load-bearing one — unknown ids pass through verbatim → wrong argv), `MODEL_EFFORT_SUPPORT["claude-code"]` (`types.ts:2361`), `MODEL_MODE_DENY["claude-code"]` (`types.ts:2588`). `claudeModelIdFromDisplayName` is generic over labels with a word-boundary guard, so `"Opus 5.5"` and `"Opus 5"` can't conflate. NewTaskForm's premium callouts are family-prefix checks (`fable-`/`mythos-`) — no Opus callout exists or is needed.
- **Cursor — verified live** (`cursor-agent models`, CLI `2026.09.18-9a7762b`, 245 rows): `claude-opus-5-5-{low,medium,high,xhigh,max}` each with a `-fast` variant, display "Claude Opus 5.5 1M <Effort>" (`-medium` is the unsuffixed "Claude Opus 5.5 1M" row = Cursor's default tier). **No `-thinking-` variants** (unlike `claude-opus-5-thinking-*`), same shape as the Opus 4.8 spec. Cursor has model discovery (`discoverCursor`), so adding the spec hides the discovered variant rows — a stored variant id would render unlisted with a collapsed effort picker → migration 056 (055/049 precedent, knowledge `3c19939d`).
- **fx — verified live**: `fx models --json` (0.0.10, build `1210c2756ea8`, unauthenticated: `auth: "missing"`, 251 ids) lists `anthropic/claude-opus-5.5` and `anthropic/claude-opus-5.5-fast`. Public Gateway catalog entry: released 2026-09-22, 1M/128K, `reasoning_options: [{type:"effort", values:[low,medium,high,xhigh,max]}]` — no `none`, no toggle, no budget (thinking can't be disabled). Not ACP-probed (no credentials); the driver validates effort at runtime regardless. All 29 previously-curated ids except `mistral/devstral-2` (pre-existing Gateway retirement, `add-grok-4-7.md` §9) are present.
- **Count-pinning surfaces that shift** with the fx row (29→30 curated, 13→14 catalogOnly, 16→17 effort-advertising, 13 no-effort unchanged): `types.ts:1834,2741-2765,2805-2806`, `types.test.ts` (`FX_EFFORT_MODELS`, catalogOnly set + `size 13`), `orchestrator.ts:5405`, `agent-discovery.ts:509` / `agent-discovery.test.ts:311` / `fx-acp.ts:496` ("then-curated … postdates" comments), `CLAUDE.md:66` ("16 standard rows … plus thirteen catalog-gated rows").
- **Default-model anchors** (`DEFAULT_MODEL["claude-code"]`, `types.ts:1799`): `effort-support.test.ts:68-76` pins `"opus-5"`; `claude-local-setting.test.ts:659-690` and `clone-endpoint.test.ts:181` derive from the constant (no edit); `e2e/agent-profiles-launch.spec.ts:62` names `"opus-5"` with a "= DEFAULT_MODEL" comment; `e2e/fx-models.spec.ts:70-77` lists catalogOnly negative labels.
- **Generic by construction (no edits)**: `model-options.ts`/`mergeModelOptions`, RunPanel/TaskLaunchPickers/CLI pickers, server effort validation, `claude-local-setting.ts`, `claude-tmux.ts` (family match is on the row name "Opus (1M context)", descriptions are noise), `e2e/fx-models.spec.ts`'s claude-picker assertion (self-derived from `AGENT_OPTIONS`).

## 3. Approach & key decisions

1. **`opus-5.5` becomes `DEFAULT_MODEL["claude-code"]`** — owner (grill Q1). Grounded in the CLI's own default flip and the lower price. Existing tasks keep their stored model; a NULL-model row re-resolves to 5.5 on its next run (the intended meaning of NULL, same as the Opus 5 flip). No migration.
2. **Coexist, not replace**: `opus-5` stays in the picker with a "Prior Opus release" hint (Opus 4.8 precedent).
3. **`opus-5.5` owns the "Opus" picker-family row; `opus-5` → `null`** (next-run breadcrumb) — *measured* (CLI 2.1.280 alias table + changelog).
4. **Effort default stays `high`** — owner (grill Q4). The Opus 5.5 hint states the model's own default is `medium` and that thinking is always on.
5. **Cursor spec `claude-opus-5-5`** (label "Opus 5.5", `supportsMaxMode`, five effort ids, `fastEfforts` all five, no thinking variants) placed right before `claude-opus-5`; **Cursor default stays `grok-4.7`** — owner (grill Q2). *Measured.*
6. **Migration 056** normalizes stored `claude-opus-5-5-*` variant ids into base + effort + fast on cursor-kind `tasks`, `agent_profiles`, and `lastModel:cursor` — byte-for-byte the 055 shape (fast written both ways; frozen `tasks.agent_profile` snapshots untouched; `updated_at` untouched).
7. **fx row `anthropic/claude-opus-5.5` is `catalogOnly: true`** — owner (grill Q3); effort set `["max","xhigh","high","medium","low","auto"]` (mirrors the Gateway `reasoning_options` + fx's always-present `auto`; identical to the live-probed `anthropic/claude-opus-5` row). The `-fast` variant stays discovery-only, like `claude-opus-5-fast`. *Rests on the Gateway catalog entry, not an ACP probe.*

## 4. Work breakdown — implementation

**T1 — shared catalogs** (`src/shared/types.ts` only)
- `DEFAULT_MODEL["claude-code"]` → `"opus-5.5"`; rewrite its comment (2.1.280 default, $4/$20, Fable-5.1-level; Mythos/Fable still 2x-usage premium above it).
- `AGENT_OPTIONS["claude-code"].models`: insert `{ id: "opus-5.5", label: "Opus 5.5", hint: "Default — Fable 5.1-level on most work at 20% below Opus 5 ($4/$20 per MTok). Thinking is always on; effort is the only control (the model's own default is medium)." }` directly above `opus-5`; `opus-5` hint → `"Prior Opus release ($5/$25 per MTok)."`.
- `MODEL_EFFORT_SUPPORT["claude-code"]["opus-5.5"] = ["max","xhigh","high","medium","low"]` above `opus-5`, with a comment that thinking can't be disabled so there is no `none` row; update the enumerating comments (`types.ts:2354-2360`) and the `EFFORT_OPTIONS` xhigh hint (`:2328`) to name Opus 5.5.
- `MODEL_MODE_DENY["claude-code"]["opus-5.5"] = []`.
- `CURSOR_MODEL_SPECS["claude-opus-5-5"]` before `"claude-opus-5"`: label "Opus 5.5", hint "Anthropic Opus 5.5 via Cursor.", `supportsMaxMode: true`, `effortIds: {max,xhigh,high,medium,low → claude-opus-5-5-<effort>}`, `fastEfforts: ["max","xhigh","high","medium","low"]`, comment: measured 2026-09-22 on cursor-agent 2026.09.18 (245 rows), no `-thinking-` variants.
- fx: `AGENT_OPTIONS.fx.models` append `{ id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", hint: "Premium Gateway tier — offered only when this account's catalog includes it.", catalogOnly: true }` at the end of the catalogOnly block; `MODEL_EFFORT_SUPPORT.fx["anthropic/claude-opus-5.5"] = ["max","xhigh","high","medium","low","auto"]` with a comment (Gateway `reasoning_options` low→max, no `none`; not ACP-probed; mirrors the probed opus-5 row). Update the count prose: `:1834` fourteen; `:2741-2765` add a 2026-09-22 paragraph (fx 0.0.10 unauth catalog 251 ids, `anthropic/claude-opus-5.5` + `-fast` present, signed-in presence unverified → catalogOnly, fourteen catalogOnly / 30 curated, `mistral/devstral-2` still absent); `:2805-2806` "17 of the 30 … the other 13".
- Acceptance: `bun run typecheck` green.

**T2 — bun driver mapping + prose** (`src/bun/agents.ts`, `src/bun/orchestrator.ts`, `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts`, `CLAUDE.md`)
- `CLAUDE_MODEL_FLAG`: add `"opus-5.5": "claude-opus-5-5"` above `"opus-5"`.
- `claudeModelPickerFamily`: `case "opus-5.5": return "Opus"`; remove the `"opus-5"` case; rewrite the doc comment (`agents.ts:200-221`): Opus follows the same current-release convention — `opus-5.5` owns the row since CLI 2.1.280 makes it the default Opus model (`opus` alias → `claude-opus-5-5`, picker row "Opus 5.5 - best for everyday, complex tasks" / "Opus 5 - previous Opus version"), so `opus-5` joins `opus-4.8/4.7/4.6` in the `null` bucket.
- `orchestrator.ts:5405` comment: "17 of its 30 curated models … the remaining 13".
- `agent-discovery.ts:509` and `fx-acp.ts:496`, `agent-discovery.test.ts:311` (comment only): add `anthropic/claude-opus-5.5` (curated since 2026-09-22) to the "postdates this measurement" clause.
- `CLAUDE.md:62`: "(incl. the superseded `fable-5` and `opus-5`)"; `CLAUDE.md:66`: "plus fourteen catalog-gated rows", add `claude-opus-5.5` to the catalogOnly enumeration with a 2026-09-22 note, "30 curated"/"14 catalogOnly" wherever the counts appear in that bullet.
- Acceptance: typecheck green; `grep -n '"opus-5"' src/bun/agents.ts` shows only the flag-table row.

**T3 — migration 056** (`src/bun/migrations/056_normalize_cursor_opus_5_5.sql` new, `src/bun/migrations/index.ts`)
- Copy 055's three UPDATEs verbatim, substituting the ten ids `claude-opus-5-5-{max,xhigh,high,medium,low}` and their `-fast` forms; effort CASE on the five prefixes (`ELSE 'low'`); `fast = CASE WHEN model LIKE '%-fast' THEN 1 ELSE 0 END`; `model = 'claude-opus-5-5'`; kind-joined via `harnesses.kind = 'cursor'`; pref `lastModel:cursor`. Header comment mirrors 055's rationale.
- `index.ts`: `import m056 … with { type: "text" }` + `{ id: "056_normalize_cursor_opus_5_5", sql: m056 }` appended last.
- Acceptance: typecheck green; `bun test src/bun/migrate.test.ts` still green (the 056 test lands in T5).

## 5. Work breakdown — tests

**T4 — catalog / driver / effort tests** (`src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`, `src/shared/types.test.ts`)
- agents.test: `buildCommand` `opus-5.5` → `--model claude-opus-5-5` (mirror `:232-240`); `claudeModelPickerFamily("opus-5.5")` → `"Opus"` in the current-release test (`:300`), and **move** `opus-5` into the null test (`:307`) with a "superseded by opus-5.5 on CLI 2.1.280" comment.
- effort-support.test: `opus-5.5` supports xhigh + max (mirror `:18`); update the default-model test (`:68-76`) to `toBe("opus-5.5")`; cursor `claude-opus-5-5`: ladder `["max","xhigh","high","medium","low"]`, `cursorModelArg("claude-opus-5-5","xhigh",false)` → `claude-opus-5-5-xhigh`, `(…,"high",true)` → `claude-opus-5-5-high-fast`, max mode `(…,"xhigh",true,true)` → `claude-opus-5-5[context=1m,effort=xhigh,fast=true]`, `cursorModelSupportsFast("claude-opus-5-5","max")` true, `cursorModelIdCoveredByCatalog("claude-opus-5-5-medium-fast")` true; cursor catalog `toContain("claude-opus-5-5")` (`:367` block) with `ids[0]` still `grok-4.7`.
- types.test: `FX_EFFORT_MODELS["anthropic/claude-opus-5.5"] = ["max","xhigh","high","medium","low","auto"]`; catalogOnly expected set + `size` 14; comment counts (17 effort-advertising).

**T5 — local-setting, mirror and migration tests** (`src/bun/claude-local-setting.test.ts`, `src/bun/orchestrator-paste-withheld.test.ts`, `src/bun/migrate.test.ts`)
- claude-local-setting.test: `claudeModelIdFromArg("claude-opus-5-5")` → `opus-5.5`; display-name: `"Opus 5.5"` → `opus-5.5`, `"Opus 5.5 (1M context) and saved …"` → `opus-5.5`, `"Opus 5 and saved …"` still `opus-5` (both directions, mirror the Fable 5.1 block `:235-260`); `parseClaudeLocalSetting` `"Set model to Opus 5.5 …"` → `{kind:"model", id:"opus-5.5"}` and `"Kept model as Opus 5.5"`.
- orchestrator-paste-withheld.test: the two mirror scenarios that drive the Opus row with `after.model = "opus-5"` (`:738` full walk, `:878` picker-not-shown) switch to `"opus-5.5"` (with the same "superseded — mirror never starts for opus-5" comment the Fable test carries at `:953`); update the expected breadcrumb text at `:883` accordingly; refresh the pane fixtures' descriptions to "Opus 5.5" (cosmetic — matching is by row name). The no-live-session test (`:1160`) stays on `opus-5` (family-independent). Add one assertion that `reconcileTaskSession` with `after.model = "opus-5"` on a live session posts the next-run breadcrumb and pastes nothing (mirror the `fable-5` treatment if such a test exists; else a minimal new one).
- migrate.test: a `056_normalize_cursor_opus_5_5` test cloned from the 055 test (`:306-419`) over the ten variant ids (plus untouched controls: a `claude-opus-5-thinking-high` cursor row, an fx `anthropic/claude-opus-5.5` row, a codex row, a NULL row, a not-a-variant `claude-opus-5-5-minimal`), asserting idempotency; extend the index-ordering test so 056 is last.

**T6 — e2e anchors** (`e2e/fx-models.spec.ts`, `e2e/agent-profiles-launch.spec.ts`)
- `EXCLUDED_FX_OPTION_LABELS` += `"Claude Opus 5.5"` with a one-line comment.
- `CLAUDE_MODEL = "opus-5.5"` (keep the `DEFAULT_MODEL` comment truthful).
- E2e applies: run recipe = `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts e2e/agent-profiles-launch.spec.ts` (one Playwright run at a time; the harness boots the headless backend itself, fx stub via `AGETOR_FX_BIN`, no credentials needed). No new e2e tests — the claude picker assertion in `fx-models.spec.ts:337` self-derives from `AGENT_OPTIONS`.

## 6. Execution waves

- Wave 1 (parallel, file-disjoint): T1 ∥ T2 ∥ T3. Barrier: `bun run typecheck`, commit.
- Wave 2 (parallel, file-disjoint): T4 ∥ T5 ∥ T6. Barrier: commit.
- Phase 5 review (opus) → Phase 7 `bun run typecheck` + `bun test` + the two e2e specs → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `task.model` is a free string column — existing claude/fx rows unaffected; PATCH validation reads the maps dynamically. Cursor rows holding a `claude-opus-5-5-*` variant id are rewritten by 056 into the shape `cursorModelArg` re-composes into the same argv.
- Demoting `opus-5` from the mirror family: a mid-session dropdown change to Opus 5 posts a next-run breadcrumb instead of driving the picker — intended (Opus 4.8 / Fable 5 precedent); launch argv unchanged.
- Default flip: New Task form, `agetor add`'s picker seed (when no `lastModel:claude-code` pref), `createTask`'s backfill, and `supportedEfforts(null)` now resolve to `opus-5.5`. A user who never touched the model picker starts paying $4/$20 instead of $5/$25 and gets the CLI's own current default — no surprise relative to running `claude` by hand.
- If a user's claude CLI is older than 2.1.280, `--model claude-opus-5-5` fails at spawn like any unknown id would; the row hint deliberately names no CLI version (Fable 5.1 precedent — the spawn error is the signal). Same exposure Fable 5.1 had at its add.
- fx: a signed-in standard catalog may not carry `anthropic/claude-opus-5.5` — `catalogOnly` hides it there; the `mergeModelOptions` logged-out distrust rule keeps the unauthenticated 251-id view from over-showing it.
- Rollback: single revert; 056 is additive-safe (re-running the pre-056 code against normalized rows just shows base ids).

## 8. Open questions / assumptions

- **A1:** fx effort set for `anthropic/claude-opus-5.5` rests on the Gateway catalog `reasoning_options` (low→max) plus fx's `auto`, not an ACP probe (no credentials). Runtime validation covers drift.
- **A2:** Signed-in Gateway presence of `anthropic/claude-opus-5.5` unverified → `catalogOnly`.
- **A3:** claude's `/model` picker family row on 2.1.280 selects Opus 5.5 — from the binary's alias table and the CHANGELOG ("now the default Opus model"); not smoke-driven live in this session. The `Set model to …` stdout sync self-corrects the row if the picker ever lands elsewhere.
- Plan approved by the owner on 2026-09-22 ("Approve, proceed").

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Four claude-code paired structures + `CLAUDE_MODEL_FLAG` | in this run — T1/T2 |
| `claudeModelPickerFamily` supersession (`opus-5` → null) + its tests + mirror fixtures | in this run — T2/T4/T5 |
| `DEFAULT_MODEL["claude-code"]` flip + every test pinning `"opus-5"` as the default | in this run — T1/T4/T6 |
| Cursor spec + variant-id normalization migration + migration test | in this run — T1/T3/T5 |
| fx catalogOnly row ↔ effort table ↔ count-pinning tests/comments/CLAUDE.md | in this run — T1/T2/T4 |
| Display-name / stdout sync tests for "Opus 5.5" vs "Opus 5" | in this run — T5 |
| e2e negative-label list + profile-launch model constant | in this run — T6 |
| `DEFAULT_EFFORT["claude-code"]` → medium | out of scope — owner chose to keep `high` (grill Q4) |
| Cursor default → `claude-opus-5-5` | out of scope — owner keeps `grok-4.7` (grill Q2) |
| Curated fx `anthropic/claude-opus-5.5-fast` row | out of scope — house convention keeps `-fast` Gateway ids discovery-only (`claude-opus-5-fast`, `gpt-5.2-fast`) |
| Rewrite existing claude tasks / `lastModel:claude-code` from `opus-5` → `opus-5.5` | out of scope — a stored model is the user's explicit choice (Opus 5 / Grok 4.7 flips set the precedent) |
| Retire `mistral/devstral-2` (still absent from the Gateway) | out of scope — pre-existing drift, a three-store retirement change; re-reported to the owner |
| Sonnet 5.5 / Haiku 5.5 ("coming weeks" per the announcement) | out of scope — not released; no ids exist in any harness catalog |
| Retire Opus 4.6/4.7 rows | out of scope — different ticket (three-store retirement), no owner ask |
