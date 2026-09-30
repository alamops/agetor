# Plan — Add GPT-6.1 Sol (codex default → 6.1 Sol, fx catalog-gated row, 0.159 CLI floor, two drift refreshes)

| Field | Value |
| --- | --- |
| Date | 2026-09-30 |
| Source | Task "Add GPT Sol 6.1" + reference https://openai.com/index/introducing-gpt-6-1-sol/ |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema; host = claude_code) |
| Flags | none |
| Gates | grilled + approved by owner (grill answered 2026-09-30) |
| Branch | feature/add-gpt-sol-6-1 |
| Base SHA | 6b8118c |

## 1. Objective & success criteria

Add OpenAI's **GPT-6.1 Sol** (`gpt-6.1-sol`, released 2026-09-29 at DevDay — "near-Astra performance for complex work at a lower cost") to every agetor catalog that can run it, and make it the **codex default** (owner decision, grill Q1).

Done means:

1. The codex picker (New Task form, task details, both launch dialogs, `agetor add`) offers GPT-6.1 Sol directly under Astra/Aeon and above GPT-6 Sol (grill Q2), with a hint naming the codex CLI ≥ 0.159 floor.
2. `DEFAULT_MODEL.codex === "gpt-6.1-sol"`; a new codex task with no model given lands on 6.1 Sol at effort `high`.
3. Effort picker offers 6.1 Sol `ultra/max/xhigh/high/medium/low` — **no `none`** (live 400 on 0.159.2: "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model").
4. `MODEL_MIN_CLI_VERSION.codex["gpt-6.1-sol"] === "0.159.0"` — the existing fail-open Pre-flight 1b refuses a start / follow-up / clone-explainer launch on an older CLI with the upgrade hint. The existing GPT-6 floors are untouched.
5. fx offers `openai/gpt-6.1-sol` as a `catalogOnly` row with efforts `max/xhigh/high/medium/low/auto` (Gateway `reasoning_options` low→max, no `none`).
6. Drift refresh (grill Q3, both swept in): (a) fx `openai/gpt-6-sol` / `openai/gpt-6-luna` effort rows become `max/xhigh/high/medium/low/none/auto` (the Gateway now advertises xhigh/max for both); (b) the codex 5.6 Sol/Terra/Luna hints drop the "codex offers the upgrade in place" claim (0.159.2's catalog carries no upgrade pointers on those rows any more; only gpt-5.5 → gpt-5.6-sol, retiring 2026-10-14).
7. Every copy that the default flip made untrue is refreshed: the GPT-6 Sol row hint (no longer "Recommended default"), hints/docs that said "switch to GPT-6 Sol", README's codex default cell, CLAUDE.md's codex + fx bullets, and every fx count (34 curated / 18 catalogOnly / 21 effort / 13 no-effort) in comments, tests and CLAUDE.md.
8. `bun run typecheck` and the full `bun test` are green.

## 2. Context & constraints (grounded)

Measured 2026-09-30 on the owner's machine (ChatGPT-plan codex login; fx 0.0.10 unauthenticated; cursor-agent 2026.09.28). Scratch artifacts: `<scratchpad>/spikes/codex-gpt61/` (app-server `model/list` per version, `codex exec` turn transcripts), `<scratchpad>/spikes/fx-cursor-gpt61/` (`fx-models.json`, `gateway-models.json`, `cursor-models.txt`).

**API facts** (developers.openai.com model page + latest-model guide; the openai.com launch post 403s to fetchers): id `gpt-6.1-sol`, reasoning effort `low|medium(default)|high|xhigh|max` — `none`/`minimal` NOT supported; 1.05M context / 128K output; $2 / $10 per MTok (cached input $0.10); cutoff 2026-04-30; tagline "Near-Astra performance for complex work at a lower cost" (TechCrunch: near-Astra quality at one-fifth Astra's price). Available from 2026-09-29 in ChatGPT (Plus/Pro/Business/Enterprise/Edu), Codex and the API. **No GPT-6.1 Luna or Astra exist** (6.1 Astra reportedly scrapped). `gpt-6-sol` stays available: no deprecation date on the deprecations page, no `upgrade` pointer in codex's catalog. "Ultrafast" is a forthcoming *service tier* (not a model id) — out of scope.

**Codex CLI — the catalog is client-version-gated, floor = 0.159.0.** Changelog: 0.157.0 (09-25) added GPT-6 Sol/Luna to the bundled catalog; 0.159.1 (09-29) "Added GPT-6.1 Sol as the default model in the bundled catalog". Live results (`codex app-server` `model/list` + `codex exec -m gpt-6.1-sol -c model_reasoning_effort=low "Reply with exactly OK"`, throwaway `CODEX_HOME` holding only `auth.json`):

| codex-cli | `model/list` has `gpt-6.1-sol` | live turn |
| --- | --- | --- |
| 0.147.0 (installed) | no (no gpt-6.x rows at all) | 400 "not supported when using Codex with a ChatGPT account" (+ "Model metadata for `gpt-6.1-sol` not found") |
| 0.155.1 (current GPT-6 floor) | no | 400 |
| 0.156.0 / 0.157.0 / 0.158.0 | no | 0.158.0: same 400 |
| 0.159.0 | **yes** | **OK** |
| 0.159.1 | yes (catalog only) | — |
| 0.159.2 (npm latest) | yes | **OK**; `none` → 400 `unsupported_value` listing low/medium/high/xhigh/max |

Catalog row on 0.159.2: display "GPT-6.1-Sol", first in the list, `supportedReasoningEfforts` low/medium/high/xhigh/max/**ultra**, default medium, `hidden:false`, `upgrade:null`. Sibling rows unchanged: gpt-6-astra (…/ultra, default low), gpt-6-sol (…/ultra, default medium), gpt-6-luna (no ultra). `gpt-6-astra-aeon` is not listed on this account (unchanged since 09-03). The 5.6 rows carry no `upgrade` pointer any more; `gpt-5.5` upgrades to `gpt-5.6-sol` and retires 2026-10-14. The 400 text is the same account-blaming wording as before — a CLI-version gate, which is exactly why Pre-flight 1b exists (`docs/plans/add-gpt-6-sol-and-luna.md` §3 D4).

**fx / Vercel AI Gateway**: `fx models --json` (empty `HOME`, 260 ids — up from 256 on 09-28, `private_models_hidden:true`) lists `openai/gpt-6.1-sol` and `openai/gpt-6.1-sol-fast`. `https://ai-gateway.vercel.sh/v1/models` `reasoning_options` for `openai/gpt-6.1-sol`: `[{type:"effort", values:["low","medium","high","xhigh","max"]}]` — no toggle, no `none` (the `-fast` twin is identical). **Drift**: `openai/gpt-6-sol` / `-luna` now read `[{type:"toggle"},{type:"effort", values:["none","low","medium","high","xhigh","max"]}]` — the 09-22 measurement (none/low/medium/high) is stale; agetor's rows must gain xhigh/max (grill Q3a). Signed-in presence of the new id is unverified (last signed-in measurement 2026-09-14) → `catalogOnly`, same reasoning as every premium row.

**Cursor**: `cursor-agent --list-models` (2026.09.28) has zero `gpt-6*` ids (newest GPT rows are the 5.6 Sol/Luna/Terra variant families). Nothing to add, no `CURSOR_MODEL_SPECS` entry, no migration.

**Code anchors** (`src/shared/types.ts` unless noted; line numbers at base `6b8118c`):
- `DEFAULT_MODEL.codex` + rationale comment `:2186-2197`.
- `AgentOption.catalogOnly` doc-comment "(the seventeen `catalogOnly` rows" `:2224`.
- `MODEL_MIN_CLI_VERSION` doc + table `:2280-2308`.
- `MODEL_EFFORT_SUPPORT` doc header "GPT-6 Sol/Luna → …" `:2804`; codex table + dated comment `:2873-2891`; fx table header comment (28/16/12 … 33rd) `:2915-2938`; fx rows for gpt-6-sol/-luna `:2977-2984`; sonnet-5.5 row (last) `:2985-2991`.
- `AGENT_OPTIONS.codex.models` `:3185-3195`; fx history comment (`:3272-3302`, last paragraph "seventeen catalogOnly rows, 33 curated ids total"); fx catalogOnly rows end at `:3334` (`anthropic/claude-sonnet-5.5`); fx `efforts` comment "20 of the 33 … other 13" `:3340-3347`.
- `src/bun/orchestrator.ts:5895-5903` — "20 of its 33 curated models … those 20; only the remaining 13".
- `src/bun/agent-discovery.ts:509-513` and `src/bun/fx-acp.ts:499-502` — "28 then-curated … postdate this measurement" enumerations.
- `src/bun/agents.ts` — no literal ids; codex argv passthrough is verbatim (`--model <id>`, `-c model_reasoning_effort=<id>`).
- `src/cli/commands/add.ts`, `src/mainview/**` — catalog-driven, no literal codex ids (`resolveInitialModel` reads `DEFAULT_MODEL.codex`).
- Tests pinning today's catalog: `src/bun/effort-support.test.ts:119-207` (default, per-model effort sets, first-8 picker order, unknown-id fallback = Sol's set incl. `none`, `MODEL_MIN_CLI_VERSION` exact four ids); `src/shared/types.test.ts:158-200` (`FX_EFFORT_MODELS` 20 rows incl. gpt-6-sol/-luna at high/…/none), `:291-345` ("seventeen" catalogOnly set + `size 17`, bidirectional keys); `src/bun/orchestrator-discovered-efforts.test.ts:129-160,318,326` (default-model literals `gpt-6-sol`); `src/bun/orchestrator-min-cli-version.test.ts:173-195` (null-model → `DEFAULT_MODEL.codex` = `gpt-6-sol`, `0.155.0`); `src/bun/agents.test.ts:587-635,737-790` (argv passthrough examples — additive); `src/bun/agent-discovery.test.ts:314-330` (fx filler test is derived from `curatedIds`, self-adjusting; the prose enumeration is historical); `e2e/fx-models.spec.ts:59-92` (`EXCLUDED_FX_OPTION_LABELS` + "nine of the seventeen" prose); `src/bun/clone-endpoint.test.ts:380-415` and `orchestrator-codex-queue-floor.test.ts` pin `gpt-6-sol` at 0.147.0 vs 0.155.1 — still valid, since gpt-6-sol's floor is unchanged.
- Docs: `README.md:78` codex default cell "GPT-6 Sol"; `CLAUDE.md` codex bullet — `[--model gpt-6-sol]`, "GPT-6 Sol (released 2026-09-22) is the default …; codex's own catalog marks GPT-5.6 Sol/Terra as upgrading to it …", "Effort `ultra` … (offered for Astra/Aeon/GPT-6 Sol/GPT-5.6 Sol/Terra/Cyber, not either Luna)", the `MODEL_MIN_CLI_VERSION` parenthetical; `CLAUDE.md` fx bullet — "seventeen catalog-gated rows" enumeration, "On 2026-09-28 it read 256 ids", "16 of the 28 then-curated ids do … `anthropic/claude-sonnet-5.5`, the 33rd" effort-group sentence, and "`openai/gpt-6-sol` and `openai/gpt-6-luna` … (none/low/medium/high)".

## 3. Approach & key decisions

- **D1 — 6.1 Sol is the codex default** (owner, Q1). Rests on spike evidence: it runs on the owner's account with a current CLI; codex 0.159.1 made it its own bundled default; OpenAI positions it as the upgrade to GPT-6 Sol at the same price. `DEFAULT_EFFORT.codex` stays `high` (offered). The installed 0.147.0 can't run it — Pre-flight 1b refuses with the `brew`/`npm` upgrade hint, exactly as with GPT-6 Sol a week ago.
- **D2 — Picker order** (owner, Q2): `gpt-6-astra, gpt-6-astra-aeon, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-cyber, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5-codex, gpt-5`.
- **D3 — Effort set from live evidence**: codex `["ultra","max","xhigh","high","medium","low"]` — `ultra` per codex's catalog (same rule as every 5.6/6 row), no `none` (live 400, API page). fx `["max","xhigh","high","medium","low","auto"]` — the Gateway's `reasoning_options` verbatim + fx's always-present `auto` (same shape as the `anthropic/claude-opus-5.5` row). Discovered efforts keep overriding the curated codex table.
- **D4 — Floor 0.159.0** for `gpt-6.1-sol` in `MODEL_MIN_CLI_VERSION.codex` (0.158.0 ✗ / 0.159.0 ✓, no 0.158.x above .0 exists). The pre-flight code needs no change — it is table-driven and already runs at `startTaskInner`, `spawnCodexTurnNow`, `sendInput` and the clone route. `upgradeHintFor` already yields `brew upgrade`/`npm i -g @openai/codex`.
- **D5 — Hints tell the truth**: new row "Recommended default — near-Astra performance for complex coding at GPT-6 Sol's price; upgrade path from GPT-6 Sol. Needs codex CLI ≥ 0.159 — older CLIs answer a 400 that misleadingly blames the ChatGPT account." GPT-6 Sol's hint drops "Recommended default" ("Previous Sol — still offered; GPT-6.1 Sol is its upgrade. Needs codex CLI ≥ 0.155 …"). The 5.6 Sol/Terra/Luna hints keep "superseded by GPT-6 Sol/Luna" but drop "(codex offers the upgrade in place)" (Q3b). GPT-5.5's hint: "switch to GPT-6.1 Sol".
- **D6 — fx row is `catalogOnly`**, label "GPT-6.1 Sol", the standard premium hint; `-fast` twin stays discovery-only like every other `-fast` id. The gpt-6-sol/-luna fx effort refresh (Q3a) is a dated in-place edit of those two rows + their comment.
- **D7 — No Cursor change, no migration** (spike: no ids). No e2e (§5).
- **D8 — Counts move in lockstep**: 34 curated = 21 effort + 13 no-effort; 18 catalogOnly; 16 standard. Every comment/assertion that names 33/17/20 is updated in the same wave (T1, T3, T5) and re-counted from the file, never copied.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusively) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Catalog + contract edits in `src/shared/types.ts`: (a) `AGENT_OPTIONS.codex.models` — insert the `gpt-6.1-sol` row after `gpt-6-astra-aeon` with the D5 hint; reword the `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` hints per D5; (b) `DEFAULT_MODEL.codex = "gpt-6.1-sol"` + rewrite the rationale comment (dated 2026-09-30, the version table in one paragraph, pointer to this plan); (c) `MODEL_EFFORT_SUPPORT.codex["gpt-6.1-sol"] = ["ultra","max","xhigh","high","medium","low"]` inserted before `gpt-6-astra`, a dated paragraph in the evidence comment (catalog ultra, `none` live-400), and the doc header line "GPT-6 Sol/Luna → …" extended with "GPT-6.1 Sol → low/medium/high/xhigh/max (+ ultra), no none"; (d) `MODEL_MIN_CLI_VERSION.codex["gpt-6.1-sol"] = "0.159.0"` + a doc-comment sentence (0.158.0 ✗ / 0.159.0 ✓, 2026-09-30); (e) fx: `MODEL_EFFORT_SUPPORT.fx["openai/gpt-6.1-sol"] = ["max","xhigh","high","medium","low","auto"]` appended after sonnet-5.5 with a dated comment; refresh `openai/gpt-6-sol`/`-luna` to `["max","xhigh","high","medium","low","none","auto"]` and rewrite their comment (2026-09-30 re-measure: toggle + none…max); a `catalogOnly` row `{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", hint: "Premium Gateway tier — offered only when this account's catalog includes it.", catalogOnly: true }` appended after sonnet-5.5; a dated 2026-09-30 paragraph in the fx history comment (260-id unauth catalog, `-fast` twin discovery-only, no 6.1 Luna); every count updated — `:2224` "seventeen" → "eighteen", fx table header "a 34th, openai/gpt-6.1-sol, joined the effort group on 2026-09-30 …", history "eighteen catalogOnly rows, 34 curated ids total", efforts comment "21 of the 34 … other 13". | `src/shared/types.ts` | — | `bun run typecheck` green; `grep -c "catalogOnly: true" src/shared/types.ts` = 18; codex picker order = D2; all count comments agree (34 = 21 + 13). |
| T2 | Docs: `README.md:78` codex default cell → "GPT-6.1 Sol"; `CLAUDE.md` codex bullet — `[--model gpt-6.1-sol]`, replace the "GPT-6 Sol (released 2026-09-22) is the default …" sentence with the 6.1 Sol default (owner decision, this plan), the 0.159.0 floor, and the corrected catalog facts (no 5.6→6 upgrade pointers any more; gpt-5.5 → gpt-5.6-sol, retires 2026-10-14), `MODEL_MIN_CLI_VERSION` parenthetical gains `gpt-6.1-sol → 0.159.0`, the `ultra` sentence gains "GPT-6.1 Sol"; `CLAUDE.md` fx bullet — "seventeen catalog-gated rows" → "eighteen" with a "— 2026-09-30 — `openai/gpt-6.1-sol` (released 2026-09-29), same unverified-signed-in reason (Gateway `reasoning_options`: low→max, no `none`; `docs/plans/add-gpt-6-1-sol.md`)" clause, a "On 2026-09-30 it read 260 ids on 0.0.10 …" sentence after the 256 one, the effort-group sentence gains "`openai/gpt-6.1-sol`, the 34th, joined the effort group on 2026-09-30 on its Gateway `reasoning_options` alone (low→max, no `none`)" and corrects the gpt-6-sol/-luna clause to "(none/low/medium/high on 2026-09-22; re-measured none…max on 2026-09-30)". | `README.md`, `CLAUDE.md` | — | `grep -n "GPT-6 Sol" README.md` shows no default cell; CLAUDE.md counts match T1. |
| T3 | Count/prose comments outside `types.ts`: `src/bun/orchestrator.ts:5895-5903` → "21 of its 33"→"21 of its 34 … plus openai/gpt-6.1-sol from its Gateway entry on 2026-09-30 … those 21; only the remaining 13"; `src/bun/agent-discovery.ts:509-513` and `src/bun/fx-acp.ts:499-502` enumerations gain `openai/gpt-6.1-sol` (curated since 2026-09-30). | `src/bun/orchestrator.ts`, `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts` | — | Typecheck green; comment-only diff. |

## 5. Work breakdown — test tasks (Wave 2, disjoint files)

| ID | Covers | Owns (exclusively) | What |
| --- | --- | --- | --- |
| T4 | T1 (codex) | `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`, `src/bun/orchestrator-discovered-efforts.test.ts`, `src/bun/orchestrator-min-cli-version.test.ts` | Default = `gpt-6.1-sol` (test name + comment cite this plan); new "GPT-6.1 Sol supports ultra through low, no none"; picker-order test pins the first 9 ids in D2 order; unknown-model fallback = 6.1 Sol's set (no `none`); `MODEL_MIN_CLI_VERSION` test → exactly five ids incl. `"gpt-6.1-sol": "0.159.0"`. `agents.test.ts`: `--model gpt-6.1-sol` verbatim passthrough + `ultra` on 6.1 Sol (additive). `orchestrator-discovered-efforts.test.ts`: the three default-model literals → `gpt-6.1-sol` (the "unknown id falls back to Sol's set" comment → 6.1 Sol's set, still includes `high`). `orchestrator-min-cli-version.test.ts:173-195`: null-model test → `gpt-6.1-sol` / "GPT-6.1 Sol" / "0.159.0"; add one case "codex 0.158.0 + gpt-6.1-sol is refused, 0.159.0 is allowed" (reuse the file's `FAKE_CODEX_VERSION` seam; the gpt-6-sol cases stay as they are since its floor is unchanged). |
| T5 | T1 (fx) | `src/shared/types.test.ts`, `e2e/fx-models.spec.ts` | `FX_EFFORT_MODELS` gains `"openai/gpt-6.1-sol": ["max","xhigh","high","medium","low","auto"]` and updates gpt-6-sol/-luna to `["max","xhigh","high","medium","low","none","auto"]` (dated comments), header prose 20→21 effort ids; `expectedCatalogOnly` gains the id (17→18, `size 18`, test names "eighteen"); bidirectional/uniqueness tests unchanged. `e2e/fx-models.spec.ts`: `EXCLUDED_FX_OPTION_LABELS` gains "GPT-6.1 Sol" with a dated comment; "nine of the seventeen" → "ten of the eighteen". (The e2e file is edited for consistency with the frozen 3-id stub; it is not run in this plan's loop — see below.) |

**e2e: not applicable.** Every change is data (catalog rows, effort tables, one floor entry, copy) riding surfaces that already have their own coverage; no new component, route shape or user flow. The floor is proven at the orchestrator layer (T4), the same layer every existing floor case is pinned at. `e2e/fx-models.spec.ts` gets a one-label edit so it stays truthful, but the unit/integration layers are the loop here (`fx-models.spec.ts` already passes with the label in the excluded list by construction — the stub never lists it).

Run recipe: `bun run typecheck`; targeted `bun test src/shared/types.test.ts src/bun/effort-support.test.ts src/bun/agents.test.ts src/bun/orchestrator-discovered-efforts.test.ts src/bun/orchestrator-min-cli-version.test.ts src/bun/orchestrator-codex-queue-floor.test.ts src/bun/clone-endpoint.test.ts src/bun/agent-discovery.test.ts src/shared/cli-version.test.ts`; then the full `bun test` (check `uptime` first — the CLI suite stalls at load 30+; load was ~5.6 at plan time; one suite at a time).

## 6. Execution waves

- **Wave 1 (parallel, disjoint):** T1 (`types.ts`), T2 (`README.md`, `CLAUDE.md`), T3 (`orchestrator.ts`, `agent-discovery.ts`, `fx-acp.ts` — comments only). Barrier: typecheck. Commit `wave 1: GPT-6.1 Sol catalog rows, codex default, 0.159 floor, fx drift refresh, docs`.
- **Phase 5:** code review of `git diff 6b8118c...HEAD` (opus, code-review skill).
- **Wave 2 (parallel, disjoint):** T4, T5. Barrier: targeted tests, then full `bun test`. Commit `wave 2: tests`.
- **Phase 8:** review must-fixes + failures, re-run to green.

## 7. Blast radius & risks

- **Default change** (`DEFAULT_MODEL.codex`): affects `createTask` with no model, `NewTaskForm`'s codex seed, CLI `resolveInitialModel`, and `supportedEfforts`' unknown-id fallback (now WITHOUT `none` — an unknown codex id pasted into the picker loses the `none` row; `gpt-6-sol` itself keeps it). Existing tasks/profiles/`lastModel:codex` prefs pinned to gpt-6-sol are untouched — the row stays curated. Rollback = revert one constant.
- **Floor**: additive table entry; the only new refusal is "codex < 0.159.0 + gpt-6.1-sol", which today fails anyway with the misleading 400 after a run row + worktree exist. The owner's own 0.147.0 will be refused on every new default-model codex task until upgraded — that is the intended, actionable outcome (the error carries `brew upgrade`/`npm i -g @openai/codex`), and the existing `AGETOR_SKIP_CLI_VERSION_FLOOR=1` escape hatch still applies.
- **fx effort refresh of gpt-6-sol/-luna**: the driver validates at runtime against fx's own `effort` option, so a value the live session doesn't offer degrades to a status breadcrumb, never a failed run.
- **fx counts**: four comment sites + two test assertions + CLAUDE.md move together (T1, T3, T5, T2).
- No migration, no schema, no route-shape change; `ALLOWED_PATCH_FIELDS` unchanged.

## 8. Open questions / assumptions

- **A1** — `ultra` on `gpt-6.1-sol` rests on codex's own catalog (`supportedReasoningEfforts` includes it); the live `none` rejection message lists only low…max. Same rule as every other row (`ultra` follows Codex's offering); a live `-c model_reasoning_effort=ultra` turn was not run (usage cost).
- **A2** — The 0.159.0 floor was measured on a ChatGPT-plan account; API-key accounts are assumed gated the same way (the existing `AGETOR_SKIP_CLI_VERSION_FLOOR` override covers the case where they aren't).
- **A3** — Whether the owner's *signed-in* Gateway catalog includes `openai/gpt-6.1-sol` is unknown → `catalogOnly` (fail-closed, as with every premium row).
- **A4** — The fx `openai/gpt-6-sol`/`-luna` xhigh/max refresh rests on the public Gateway catalog, not an ACP probe (no fx credentials that pass), same standing as the rows' original entries.
- Grill Q&A (owner, 2026-09-30): Q1 default → 6.1 Sol; Q2 order → below Astra/Aeon, above GPT-6 Sol; Q3 → sweep both drifts in.

## 8b. Review outcome (Phase 5, opus, code-review skill — 2026-09-30)

4 findings: 0 must-fix, 1 should-fix, 3 nice-to-have; all four addressed in Phase 8, none deferred.
1. should-fix — the new fx `openai/gpt-6.1-sol` effort row + comment were inserted between Sonnet 5.5's evidence comment and Sonnet 5.5's row → moved below the Sonnet row so every row sits under its own dated comment.
2. nice — the fx effort-table header still quoted the 2026-09-22 (none/low/medium/high) values for gpt-6-sol/-luna → re-measure parenthetical added.
3. nice — "0.147.0 through 0.158.0 … answer the 400" overstated what was measured (live turns ran on 0.147.0/0.155.1/0.158.0 only; the `model/list` omission was probed on every version) → comment + CLAUDE.md reworded.
4. nice — `-fast` twins' effort-picker fallback not covered by §7/§9 → ledger row added (out of scope, pre-existing for every `-fast` id).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Codex picker row + hint for 6.1 Sol | **in this run** — T1 |
| Codex default → 6.1 Sol (+ comment, every consumer test) | **in this run** — T1, T4 |
| Effort set for 6.1 Sol (codex + fx) | **in this run** — T1, T4, T5 |
| 0.159.0 floor + its tests | **in this run** — T1, T4 |
| fx catalogOnly row + effort entry + every count comment/assertion (types.ts ×4, orchestrator.ts, agent-discovery.ts, fx-acp.ts, types.test.ts, e2e spec, CLAUDE.md) | **in this run** — T1, T3, T5, T2 |
| Copy the default flip made untrue (GPT-6 Sol "Recommended default", GPT-5.5 "switch to GPT-6 Sol", README default cell, CLAUDE.md) | **in this run** — T1, T2 |
| fx gpt-6-sol/-luna effort rows missing xhigh/max (pre-existing drift) | **in this run** — T1, T5 (owner Q3a) |
| 5.6 row hints claiming an in-place upgrade pointer codex no longer carries (pre-existing drift) | **in this run** — T1, T2 (owner Q3b) |
| Cursor rows for GPT-6.1 Sol | **out of scope** — no such id in cursor-agent 2026.09.28 (spike); nothing to add, no migration |
| `gpt-6.1-luna` / `gpt-6.1-astra` rows | **out of scope** — no such models exist |
| "Ultrafast" service tier | **out of scope** — not a model id; not live yet |
| `openai/gpt-6.1-sol-fast` fx row | **out of scope** — `-fast` twins are discovery-only for every fx model today |
| Retiring `gpt-5.5` (codex says 2026-10-14) | **out of scope** — future dated event; retiring a curated id is its own three-store change |
| Historical "28 then-curated" measurement prose in `agent-discovery.test.ts`/`agent-discovery.ts`/`fx-acp.ts` | the enumerations of ids that postdate it are extended (T3); the measurement itself stays historical — **out of scope** to re-measure |
| `openai/gpt-6.1-sol-fast` (and every other fx `-fast` twin) surfacing as a discovered-only row inherits `DEFAULT_MODEL.fx`'s effort set in the picker (`supportedEfforts` fallback), not its own Gateway `reasoning_options` (review finding 4) | **out of scope** — pre-existing behavior for every `-fast` twin, unchanged by this run; harmless at runtime (an unoffered value degrades to a status breadcrumb); a base-id lookup for `-fast` ids is its own change |
| Owner-deferred | none |
