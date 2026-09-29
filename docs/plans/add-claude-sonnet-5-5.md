# Plan — Claude Sonnet 5.5 for Claude Code, Cursor and fx

| Field | Value |
| --- | --- |
| Date | 2026-09-28 |
| Source | /implement "Claude Sonnet 5.5" (agetor task; ref: https://www.anthropic.com/claude-sonnet-5-5) |
| Config | AGENTS_CONFIG.yml (balanced preset, v1 schema) |
| Flags | none |
| Gates | Grilled + plan approved by owner (2026-09-28) |
| Branch | feature/add-claude-sonnet-5-5 |
| Base SHA | bd5adcba1fd2c0df6d375fa43c9432294fe12dec (tree clean apart from this plan file) |
| Rebase | 2026-09-29: rebased onto `main` 6cd0241 (Pipelines, #244), which took migrations 057–059 — the Cursor normalization written here as 057 was renumbered to **060**, with `057_normalize_cursor_sonnet_5_5` kept as an alias in `migrations/index.ts`. Every migration number below reads 060 accordingly. |

## 1. Objective & success criteria

Add **Claude Sonnet 5.5** (`claude-sonnet-5-5`, released 2026-09-28) as a selectable model on every harness whose catalog offers it: **claude-code** (curated row, *not* the default), **Cursor** (measured spec + variant-id migration 060), and **fx** (catalog-gated row). Codex and Gemini don't run Anthropic models — not applicable.

Done means: the row renders in every picker (New Task, task details, launch dialogs, CLI), a claude-code run passes `--model claude-sonnet-5-5`, the effort picker offers low→max, a mid-session dropdown change to `sonnet-5.5` drives claude's `/model` Sonnet row while `sonnet-5` becomes next-run-only, claude's `Set model to Sonnet 5.5` stdout syncs back to the row (and `Sonnet 5` still syncs to `sonnet-5`), Cursor composes `claude-sonnet-5-5-<effort>` with no `-fast` form and no max-mode bracket, stored Cursor variant ids are normalized by migration 060, fx offers `anthropic/claude-sonnet-5.5` when the signed-in catalog contains it, `bun run typecheck` and `bun test` are green (modulo the three pre-existing failures on main), and the two touched e2e specs pass.

## 2. Context & constraints (grounded, measured 2026-09-28)

- **Model identity** (anthropic.com/claude-sonnet-5-5 + the claude-api skill's model table): id `claude-sonnet-5-5` (no date suffix); 1M context / 128K output; $2/$10 per MTok, cache reads $0.20 (same as Sonnet 5). "Faster, lower-cost complement" to Opus 5.5; 30%+ faster than Sonnet 5. Effort `low|medium|high|xhigh|max`, API default `high`; **Claude Code sets its default effort for this model to `medium`**. Thinking can't be disabled the old way — `{type:"disabled"}` 400s; the API-side off switch is `{type:"between_tools"}` — none of which agetor sends (effort rides `CLAUDE_CODE_EFFORT_LEVEL`), so there is no `none` row.
- **claude CLI 2.1.284 (installed)** — *measured from the binary* (`grep -a -o` on `~/.local/share/claude/versions/2.1.284`): 24 `claude-sonnet-5-5` occurrences; alias table `sonnet:"claude-sonnet-5-5"`, `default:"claude-sonnet-5-5"` (alongside `default:"claude-opus-5-5"` — claude's overall `default` is still Opus 5.5); picker rows "Sonnet 5.5" / "Sonnet 5 - previous Sonnet version"; `PREV_SONNET_ID:"claude-sonnet-5"`. 2.1.282 and 2.1.283 carry zero occurrences (alias `sonnet:"claude-sonnet-5"`). CHANGELOG 2.1.284: "Added Claude Sonnet 5.5 (`claude-sonnet-5-5`), now the default Sonnet model on the Anthropic API — 1M context, $2/$10 per Mtok with $0.20/Mtok cache reads".
- **Picker-family mirror** (`claudeModelPickerFamily`, `src/bun/agents.ts:229`): one row per family, always the family's *current* release. Since 2.1.284's Sonnet row resolves to 5.5, `sonnet-5.5` must own `"Sonnet"` and `sonnet-5` must drop to `null` — the same supersession as `opus-5` → `opus-5.5` (`docs/plans/add-claude-opus-5-5.md` §2) and `fable-5` → `fable-5.1`. Gotcha carried from that run (peer workdone `fc7955e7`): `reconcileTaskSession` checks the family BEFORE the live-session check, so every mirror fixture whose `after.model` is `sonnet-5` must move to `sonnet-5.5` or it now short-circuits with a next-run breadcrumb.
- **claude-code paired structures** (peer checklist, knowledge `660ed97d`): `AGENT_OPTIONS["claude-code"].models` (`types.ts:2731`), `CLAUDE_MODEL_FLAG` (`agents.ts:153`, the load-bearing one — unknown ids pass through verbatim), `MODEL_EFFORT_SUPPORT["claude-code"]` (`types.ts:2418`), `MODEL_MODE_DENY["claude-code"]` (`types.ts:2674`). `claudeModelIdFromDisplayName` is word-boundary-guarded so `"Sonnet 5.5"` and `"Sonnet 5"` can't conflate (same guard the Opus 5.5 tests pin). NewTaskForm's premium callouts are family-prefix checks (`fable-`/`mythos-`) — no Sonnet callout exists or is needed. No `Sonnet 5` string is pinned anywhere in `src/mainview` or `src/cli` outside tests.
- **Cursor — verified live** (`cursor-agent models`, CLI `2026.09.26-dd393fe`, 250 rows): `claude-sonnet-5-5-{low,medium,high,xhigh,max}` labelled "Claude Sonnet 5.5 <Effort>". **No `-fast` variants, no `-thinking-` variants**, and — unlike every other `supportsMaxMode` spec's rows (Opus 5.5 / 4.8, Fable 5.1, Sonnet 5, Sonnet 4.6, GPT-5.6 Terra all read "… 1M …") — **no "1M" in the label**. Cursor has model discovery (`discoverCursor`), so adding the spec hides the discovered variant rows; a stored variant id would render unlisted with a collapsed effort picker → migration 060 (055/056 precedent).
- **fx — verified live**: `fx models --json` (0.0.10, build `1210c2756ea8`, unauthenticated: `auth: "missing"`, **256 ids**, up from 255 on 2026-09-22) lists `anthropic/claude-sonnet-5.5` (no `-fast` twin). Public Gateway catalog (`ai-gateway.vercel.sh/v1/models`, 390 entries): 1M/128K, $2/$10, `reasoning_options: [{type:"effort", values:[low,medium,high,xhigh,max]}]` — no `toggle`, no `none`, no `budget_tokens` (contrast the Gateway's own `anthropic/claude-sonnet-5` entry, which lists toggle + none…max + budget yet live-probed on fx to `xhigh/high/medium/low/auto` — the ACP probe is the truth where one exists; none is possible here). All 32 previously-curated ids except `mistral/devstral-2` (pre-existing Gateway retirement) are present.
- **Count-pinning surfaces that shift** with the fx row (32→33 curated, 16→17 catalogOnly, 19→20 effort-advertising, 13 no-effort unchanged): `types.ts` DEFAULT_MODEL.fx comment ("sixteen `catalogOnly` rows"), the fx effort-table header comment (`types.ts:2505-2515`), the fx models prose (`types.ts:2859-2870`) and the `efforts:` comment (`:2910-2913`); `types.test.ts` (`FX_EFFORT_MODELS` 19→20, `size 16`→17, "32 curated"→33); `orchestrator.ts:5601-5607` ("19 of its 32"); `agent-discovery.ts:509-510` / `agent-discovery.test.ts:316-317` / `fx-acp.ts:500` ("postdates" clauses); `CLAUDE.md:63` (superseded list) and `:67` ("plus sixteen catalog-gated rows", "31st and 32nd", "On 2026-09-22 it read 255 ids"); `e2e/fx-models.spec.ts:59-80` ("six of the fourteen" is already stale vs. sixteen — fix to "seven of the seventeen").
- **Default-model anchors**: untouched — `DEFAULT_MODEL["claude-code"]` stays `opus-5.5` (owner, grill Q1), so `effort-support.test.ts:77-85`, `e2e/agent-profiles-launch.spec.ts:62` and `clone-endpoint.test.ts` need no edit.
- **Generic by construction (no edits)**: `model-options.ts`/`mergeModelOptions`, RunPanel/TaskLaunchPickers/CLI pickers, server effort validation, `claude-local-setting.ts`, `claude-tmux.ts` (family match is on the row name "Sonnet"; the doc-comment pane examples at `:2713/:7926/:8012` are verbatim 2.1.246 captures and stay), `e2e/fx-models.spec.ts`'s claude-picker assertion (self-derived from `AGENT_OPTIONS`).

## 3. Approach & key decisions

1. **`DEFAULT_MODEL["claude-code"]` stays `opus-5.5`** — owner (grill Q1). Anthropic positions Sonnet 5.5 as the complement; claude's own `default` alias still resolves to `claude-opus-5-5`. Sonnet 5.5 is a picker row placed directly above `sonnet-5`.
2. **Coexist, not replace**: `sonnet-5` stays with a "Prior Sonnet release" hint (Opus 5 precedent).
3. **`sonnet-5.5` owns the "Sonnet" picker-family row; `sonnet-5` → `null`** (next-run breadcrumb) — *measured* (2.1.284 alias table + picker strings + CHANGELOG).
4. **Effort default stays `high`** — owner (grill Q2). The Sonnet 5.5 hint states that Claude Code's own default for it is `medium`.
5. **Cursor spec `claude-sonnet-5-5`** (label "Sonnet 5.5", five effort ids, **no `fastEfforts`**, **`supportsMaxMode` omitted (false)**) placed right before `claude-sonnet-5`; **Cursor default stays `grok-4.7`** — owner (grill Q3). *Max mode was the one judgment call and is now spike-settled* (§8 A1): the rows carry no "1M" label while every other max-mode-enabled spec's rows do, and the live probes show cursor-agent 2026.09.26 rejects the `[context=1m,…]` bracket for Sonnet 5.5 in both shapes while accepting Opus 5.5's real shape — so the spec keeps max mode off (a hidden toggle costs nothing; a rejected bracket fails the spawn). Flipping it later is a one-line change plus one test assertion.
6. **Migration 060** normalizes stored `claude-sonnet-5-5-*` variant ids into base id + effort on cursor-kind `tasks`, `agent_profiles`, and `lastModel:cursor` — the 056 shape with five ids instead of ten and `fast = 0` (no `-fast` forms exist; writing 0 keeps a stale `fast=1` from ever mattering if Cursor later adds them). Frozen `tasks.agent_profile` snapshots untouched; `updated_at` untouched.
7. **fx row `anthropic/claude-sonnet-5.5` is `catalogOnly: true`** — owner (grill Q4); effort set `["max","xhigh","high","medium","low","auto"]` (Gateway `reasoning_options` + fx's always-present `auto`; the same shape as the opus-5.5 row). *Rests on the Gateway catalog entry, not an ACP probe* (A2).

## 4. Work breakdown — implementation

**T1 — shared catalogs** (`src/shared/types.ts` only)
- `AGENT_OPTIONS["claude-code"].models`: insert `{ id: "sonnet-5.5", label: "Sonnet 5.5", hint: "Faster, lower-cost complement to Opus 5.5 ($2/$10 per MTok) — 30%+ faster than Sonnet 5 on coding/agentic work. Claude Code's own default effort for it is medium." }` directly above `sonnet-5`; `sonnet-5` hint → `"Prior Sonnet release ($2/$10 per MTok)."`.
- `MODEL_EFFORT_SUPPORT["claude-code"]["sonnet-5.5"] = ["max","xhigh","high","medium","low"]` above `sonnet-5`, with a comment (thinking can't be disabled via `{type:"disabled"}` — the API's `between_tools` off switch is nothing agetor sends — so no `none` row; API default `high`, Claude Code's own default `medium`; agetor pins `CLAUDE_CODE_EFFORT_LEVEL` from `DEFAULT_EFFORT`). Update the enumerating comment (`:2408-2412`: "Sonnet 5.5 / 5") and the `EFFORT_OPTIONS` xhigh hint (`:2381`: "… / Sonnet 5.5 / 5 / codex").
- `MODEL_MODE_DENY["claude-code"]["sonnet-5.5"] = []` above `sonnet-5`.
- `CURSOR_MODEL_SPECS["claude-sonnet-5-5"]` before `"claude-sonnet-5"`: label "Sonnet 5.5", hint "Anthropic Sonnet 5.5 via Cursor.", `effortIds: {max,xhigh,high,medium,low → claude-sonnet-5-5-<effort>}`, no `fastEfforts`, no `supportsMaxMode`; comment: measured 2026-09-28 on cursor-agent 2026.09.26 (250 rows), no `-fast` / `-thinking-` variants, rows labelled without "1M" unlike Sonnet 5's — max mode deliberately off until Cursor labels a 1M row (plan §8 A1).
- fx: `AGENT_OPTIONS.fx.models` append `{ id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", hint: "Premium Gateway tier — offered only when this account's catalog includes it.", catalogOnly: true }` at the end of the catalogOnly block; `MODEL_EFFORT_SUPPORT.fx["anthropic/claude-sonnet-5.5"] = ["max","xhigh","high","medium","low","auto"]` appended with a comment (2026-09-28, Gateway `reasoning_options` effort low→max, no toggle/none/budget; not ACP-probed; mirrors the opus-5.5 row's shape). Update the count prose: DEFAULT_MODEL.fx comment "seventeen `catalogOnly` rows"; effort-table header: "a 33rd, anthropic/claude-sonnet-5.5, joined the effort group on 2026-09-28"; fx models prose: add a 2026-09-28 paragraph (fx 0.0.10 unauth catalog 256 ids, `anthropic/claude-sonnet-5.5` present, no `-fast` twin, signed-in presence unverified → catalogOnly, seventeen catalogOnly / 33 curated, `mistral/devstral-2` still absent); `efforts:` comment "20 of the 33 … the other 13".
- Acceptance: `bun run typecheck` green.

**T2 — bun driver mapping + prose** (`src/bun/agents.ts`, `src/bun/orchestrator.ts`, `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts`, `src/bun/agent-discovery.test.ts` comment only, `CLAUDE.md`)
- `CLAUDE_MODEL_FLAG`: add `"sonnet-5.5": "claude-sonnet-5-5"` above `"sonnet-5"`.
- `claudeModelPickerFamily`: `case "sonnet-5.5": return "Sonnet"`; remove the `"sonnet-5"` case; extend the doc comment: Sonnet follows the same rule — `sonnet-5.5` owns the "Sonnet" row because claude 2.1.284 makes `claude-sonnet-5-5` the default Sonnet model (alias `sonnet` → `claude-sonnet-5-5`, picker row "Sonnet 5 - previous Sonnet version", CHANGELOG "now the default Sonnet model on the Anthropic API"), so `sonnet-5` joins the null bucket.
- `orchestrator.ts:2626`: alias example → `sonnet-5.5`; `:5601-5607`: "20 of its 32"→"20 of its 33 … plus anthropic/claude-opus-5.5, openai/gpt-6-sol, openai/gpt-6-luna (2026-09-22) and anthropic/claude-sonnet-5.5 (2026-09-28) … those 20; … remaining 13".
- `agent-discovery.ts:509-510`, `fx-acp.ts:500`, `agent-discovery.test.ts:316-317`: add `anthropic/claude-sonnet-5.5` (curated since 2026-09-28) to the "postdates" clause.
- `CLAUDE.md:63`: "(incl. the superseded `fable-5`, `opus-5` and `sonnet-5`)"; `CLAUDE.md:67`: "plus seventeen catalog-gated rows", add `anthropic/claude-sonnet-5.5` (2026-09-28, launch day, same unverified-signed-in reason; Gateway `reasoning_options` low→max; `docs/plans/add-claude-sonnet-5-5.md`) to the catalogOnly enumeration and "the 33rd" to the effort-group sentence, and append "On 2026-09-28 it read 256 ids on 0.0.10, every curated id present except the already-retired mistral/devstral-2" after the 2026-09-22 sentence.
- Acceptance: typecheck green; `grep -n '"sonnet-5"' src/bun/agents.ts` shows only the flag-table row.

**T3 — migration 060** (`src/bun/migrations/060_normalize_cursor_sonnet_5_5.sql` new, `src/bun/migrations/index.ts`)
- Clone 056's three UPDATEs with the five ids `claude-sonnet-5-5-{max,xhigh,high,medium,low}`; effort CASE on the five prefixes (`ELSE 'low'`); `fast = 0` (comment: no `-fast` forms exist for this model on cursor-agent 2026.09.26; zeroing a stale flag keeps a later Cursor `-fast` addition from silently switching the task); `model = 'claude-sonnet-5-5'`; kind-joined via `harnesses.kind = 'cursor'`; pref `lastModel:cursor`. Header comment mirrors 056's rationale and says "Do NOT touch `claude-sonnet-5-*` (Sonnet 5) ids".
- `index.ts`: `import m060 … with { type: "text" }` + `{ id: "060_normalize_cursor_sonnet_5_5", sql: m060 }` appended last.
- Acceptance: typecheck green; `bun test src/bun/migrate.test.ts` still green (the 060 test lands in T5).

## 5. Work breakdown — tests

**T4 — catalog / driver / effort tests** (`src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`, `src/shared/types.test.ts`)
- agents.test: `buildCommand` `sonnet-5.5` → `--model claude-sonnet-5-5` (mirror the opus-5.5 test); `claudeModelPickerFamily("sonnet-5.5")` → `"Sonnet"` in the current-release test, and **move** `sonnet-5` into the null test with a "superseded by sonnet-5.5 on CLI 2.1.284" comment.
- effort-support.test: `sonnet-5.5` supports xhigh + max; cursor catalog `toContain("claude-sonnet-5-5")` with `ids[0]` still `grok-4.7`; cursor ladder `["max","xhigh","high","medium","low"]`; `cursorModelArg("claude-sonnet-5-5","xhigh",false)` → `claude-sonnet-5-5-xhigh`, `(…,"high",true)` → `claude-sonnet-5-5-high` (no `-fast`), `cursorModelSupportsFast("claude-sonnet-5-5","max")` false, `cursorModelSupportsMaxMode("claude-sonnet-5-5")` false and `cursorModelArg(…,"xhigh",false,true)` → `claude-sonnet-5-5-xhigh` (bracket never emitted), `cursorModelIdCoveredByCatalog("claude-sonnet-5-5-medium")` true, `("claude-sonnet-5-5-medium-fast")` true (the generic `${variant}-fast` rule — documented as such), `("claude-sonnet-5-5-thinking-high")` false, `("claude-sonnet-5-max")` still true.
- types.test: `FX_EFFORT_MODELS["anthropic/claude-sonnet-5.5"] = ["max","xhigh","high","medium","low","auto"]`; counts 20 / 13 / 33; catalogOnly expected set + `size` 17 with a 2026-09-28 comment; test titles "seventeen".

**T5 — local-setting, mirror and migration tests** (`src/bun/claude-local-setting.test.ts`, `src/bun/orchestrator-paste-withheld.test.ts`, `src/bun/migrate.test.ts`)
- claude-local-setting.test: `claudeModelIdFromArg("claude-sonnet-5-5")` → `sonnet-5.5`; display-name both directions (`"Sonnet 5.5"`, `"Sonnet 5.5 (1M context)"`, `"Sonnet 5.5 and saved …"` → `sonnet-5.5`; `"Sonnet 5"`, `"Sonnet 5 and saved …"` → `sonnet-5`); `parseClaudeLocalSetting` `"Set model to Sonnet 5.5 …"` → `{kind:"model", id:"sonnet-5.5"}` and `"Kept model as Sonnet 5.5"` → `kept: true`. Existing `Sonnet 5` fixtures stay (label still curated; `"Opus 6"` comment "tops out at Opus 5.5" unchanged).
- orchestrator-paste-withheld.test: the modal-guard mirror test (`:271-283`, `after.model = "sonnet-5"`) → `"sonnet-5.5"` with the superseded comment, expectation `includes("sonnet-5.5")`; both pane fixtures' Sonnet descriptions → "Sonnet 5.5 — fast and cost-effective" (cosmetic, matching is by row name); add a `sonnet-5` twin of the "superseded pinned id (opus-5) never drives the picker" test (`:834-893`) asserting the next-run breadcrumb and zero tmux calls. Tasks whose *before* model is `sonnet-5` stay as they are (only `after.model` is family-gated).
- migrate.test: import 060; a `060_normalize_cursor_sonnet_5_5` test cloned from the 056 test (`:425-543`) over the five variant ids (fast written 0 for all — include one row seeded with `fast=1` to pin the reset), untouched controls (a `claude-sonnet-5-max` cursor row, a `claude-opus-5-5-high` cursor row, an fx `anthropic/claude-sonnet-5.5` row, a codex row, a NULL row, a not-a-variant `claude-sonnet-5-5-minimal`), idempotency; update "056 is the last registered migration" → 060 is last, right after 056.

**T6 — e2e anchors** (`e2e/fx-models.spec.ts`)
- `EXCLUDED_FX_OPTION_LABELS` += `"Claude Sonnet 5.5"` with a one-line comment; fix the stale count prose to "seven of the seventeen".
- E2e applies: run recipe = `export PATH="$HOME/.bun/bin:$PATH"; bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts e2e/agent-profiles-launch.spec.ts` (one Playwright run at a time; the harness boots the headless backend itself, fx stub via `AGETOR_FX_BIN`, no credentials needed). No new e2e tests — the claude picker assertion in `fx-models.spec.ts` self-derives from `AGENT_OPTIONS`.

## 6. Execution waves

- Wave 1 (parallel, file-disjoint): T1 ∥ T2 ∥ T3. Barrier: `bun run typecheck`, commit.
- Wave 2 (parallel, file-disjoint): T4 ∥ T5 ∥ T6. Barrier: commit.
- Phase 5 review (opus, code-review skill) → Phase 7 `bun run typecheck` + `bun test` + the two e2e specs → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `task.model` is a free string column — existing claude/fx rows unaffected; PATCH validation reads the maps dynamically. Cursor rows holding a `claude-sonnet-5-5-*` variant id are rewritten by 060 into the shape `cursorModelArg` re-composes into the same argv.
- Demoting `sonnet-5` from the mirror family: a mid-session dropdown change to Sonnet 5 posts a next-run breadcrumb instead of driving the picker — intended (Opus 5 / Fable 5 precedent); launch argv unchanged.
- No default flip: nothing about New Task, `agetor add`'s seed, or `createTask`'s backfill changes.
- If a user's claude CLI is older than 2.1.284, `--model claude-sonnet-5-5` fails at spawn like any unknown id would; the row hint names no CLI version (Opus 5.5 / Fable 5.1 precedent — the spawn error is the signal).
- Cursor max mode off for this model: a user who wants 1M context on Sonnet 5.5 via Cursor can't toggle it until the spec flips (A1); no run can fail because of it.
- fx: a signed-in standard catalog may not carry `anthropic/claude-sonnet-5.5` — `catalogOnly` hides it there; the `mergeModelOptions` logged-out distrust rule keeps the unauthenticated 256-id view from over-showing it.
- Rollback: single revert; 060 is additive-safe (pre-060 code against normalized rows just shows base ids).

## 8. Open questions / assumptions

- **A1 (Cursor max mode) — spike-settled 2026-09-28 (owner-approved live probes, cursor-agent 2026.09.26, `-p --trust --output-format text`, tools off, scratchpad workspace, prompt "Reply with exactly the word: ok"):** `supportsMaxMode` stays off, and the verdict is MODEL-SPECIFIC. Results: `claude-sonnet-5-5-low` → `ok`; `claude-sonnet-5-5[context=1m,effort=low]` → rejected up front (`Cannot use this model: … Available models: <flat list>`); `claude-sonnet-5-5[context=1m,effort=low,fast=false]` → rejected; `claude-opus-5-5[context=1m,effort=low,fast=false]` (agetor's exact shape for Opus 5.5, whose spec has `fastEfforts`) → **`ok`**; `claude-opus-5-5[context=1m,effort=low]` (no `fast=`) → rejected; the help text's own example `claude-opus-4-8[context=1m,effort=high,fast=false]` → rejected; `claude-sonnet-5[context=1m,effort=low]` (agetor's exact shape for Sonnet 5, no `fastEfforts`) → rejected. So the bracket form does work under `-p` (Opus 5.5 proves it) and the Sonnet 5.5 rejection is a property of that model on this build — consistent with its rows lacking Cursor's "1M" label. Flipping the spec later is one line + two assertions in T4. Artifacts: `<scratchpad>/spikes/cursor-sonnet-55-maxmode/*.{out,err}`.
- **A2:** fx effort set for `anthropic/claude-sonnet-5.5` rests on the Gateway catalog `reasoning_options` (low→max) plus fx's `auto`, not an ACP probe (no credentials). Runtime validation covers drift — the same caveat opus-5.5 carries, with the added evidence that the Gateway's sonnet-5 entry over-reports vs. its live probe.
- **A3:** Signed-in Gateway presence of `anthropic/claude-sonnet-5.5` unverified → `catalogOnly`.
- **A4:** claude's `/model` picker family row on 2.1.284 selects Sonnet 5.5 — from the binary's alias table, picker strings and the CHANGELOG; not smoke-driven live in this session. The `Set model to …` stdout sync self-corrects the row if the picker ever lands elsewhere.

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Four claude-code paired structures + `CLAUDE_MODEL_FLAG` | in this run — T1/T2 |
| `claudeModelPickerFamily` supersession (`sonnet-5` → null) + its tests + mirror fixtures + the superseded-id mirror test | in this run — T2/T4/T5 |
| Cursor spec + variant-id normalization migration + migration test | in this run — T1/T3/T5 |
| fx catalogOnly row ↔ effort table ↔ count-pinning tests/comments/CLAUDE.md | in this run — T1/T2/T4 |
| Display-name / stdout sync tests for "Sonnet 5.5" vs "Sonnet 5" | in this run — T5 |
| e2e negative-label list + its stale "six of the fourteen" count | in this run — T6 |
| `orchestrator.ts` alias-example comment naming `sonnet-5` | in this run — T2 |
| `DEFAULT_MODEL["claude-code"]` → sonnet-5.5 | out of scope — owner keeps `opus-5.5` (grill Q1) |
| Per-model default effort (`medium` for Sonnet 5.5) | out of scope — owner keeps the per-kind `high` (grill Q2) |
| Cursor default → `claude-sonnet-5-5` | out of scope — owner keeps `grok-4.7` (grill Q3) |
| Cursor `supportsMaxMode` for Sonnet 5.5 | out of scope pending evidence — A1; one-line flip |
| Rewrite existing claude tasks / `lastModel:claude-code` from `sonnet-5` → `sonnet-5.5` | out of scope — a stored model is the user's explicit choice (Opus 5.5 precedent) |
| Retire `mistral/devstral-2` (still absent from the Gateway) | out of scope — pre-existing drift, its own three-store retirement change |
| Haiku 5.5 | out of scope — not released; no id in any harness catalog |
| `claude-tmux.ts` doc-comment pane examples naming "Sonnet 5" | out of scope — verbatim 2.1.246 captures documenting the parser, not model facts |
| cursor-agent 2026.09.26 rejects agetor's max-mode bracket for `claude-sonnet-5` (`claude-sonnet-5[context=1m,effort=low]`) and for the no-`fast=` Opus 5.5 form, while accepting Opus 5.5's real `…,fast=false]` shape — so a Sonnet 5 (and possibly other no-`fastEfforts`) task with Max mode on fails at spawn today | out of scope — pre-existing, not introduced here; needs its own per-spec probe matrix (each probe is a paid request); surfaced to the owner in the report as its own ticket |
