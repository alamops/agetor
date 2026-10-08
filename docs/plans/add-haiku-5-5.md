# Plan — Claude Haiku 5.5 for Claude Code, Cursor and fx

| Field | Value |
| --- | --- |
| Date | 2026-10-07 |
| Source | /implement "add Haiku 5.5 (just announced by Claude)" |
| Config | AGENTS_CONFIG.yml (balanced preset, v1 schema — `/implement --update` exists and was not run) |
| Host | cursor (Cursor Task tool + local binaries). Investigate used Claude Sonnet 5.5 via Cursor's Task tool, plus direct catalog probes. |
| Flags | none |
| Gates | Grill questions skipped by the owner — decisions below are the recommended defaults, logged in §8. Plan approved 2026-10-07 ("go ahead"). |
| Branch | feature/add-haiku-5-5 |
| Base SHA | e55270a9bb9ad40553817e07adc9517cce83e70a |

## 1. Objective & success criteria

Add **Claude Haiku 5.5** (`claude-haiku-5-5`, released 2026-10-07) as a selectable model on every harness whose catalog offers it: **claude-code** (curated row, not the default), **Cursor** (measured spec + variant-id migration 062), and **fx** (catalog-gated row). Codex and Gemini don't run Anthropic models. Antigravity's hand-listed catalog is left alone.

Done means: the row renders in every claude-code / Cursor / fx picker, a claude-code run passes `--model claude-haiku-5-5` with `CLAUDE_CODE_EFFORT_LEVEL` set for low→max, the effort picker offers that ladder (Haiku 4.5 stays empty), a mid-session dropdown change to `haiku-5.5` drives claude's `/model` Haiku row while `haiku-4.5` becomes next-run-only, claude's `Set model to Haiku 5.5` stdout syncs back to `haiku-5.5` (and `Haiku 4.5` still syncs to `haiku-4.5`), Cursor composes `claude-haiku-5-5-thinking-<effort>` with no `-fast` form and no max-mode bracket, stored Cursor *thinking* variant ids are normalized by migration 062, fx offers `anthropic/claude-haiku-5.5` when the signed-in catalog contains it, and `bun run typecheck` plus the touched unit tests and `e2e/fx-models.spec.ts` are green.

## 2. Context & constraints (measured 2026-10-07)

- **Model identity** ([announcement](https://www.anthropic.com/claude-haiku-5-5), [models overview](https://platform.claude.com/docs/en/docs/about-claude/models/overview)): id `claude-haiku-5-5`; 1M context / 128K output; thinking "Adaptive"; API default effort `medium`. Price is tiered by prompt length: $0.10 / $0.50 per MTok input/output up to 100k tokens, $0.50 / $2.50 above that (~75% below Haiku 4.5 on the short-prompt tier). Knowledge cutoff June 2026. Retirement not sooner than 2027-10-07.
- **claude CLI 2.1.293 (installed)** — binary `~/.local/share/claude/versions/2.1.293`: 21 `claude-haiku-5-5` occurrences. 2.1.290 / 2.1.291 / 2.1.292 have zero. Alias table `haiku:{default:"claude-haiku-5-5"}` and `family.haiku:"claude-haiku-5-5"`. Constants object (same one that pins current Opus/Sonnet): `HAIKU_ID:"claude-haiku-5-5"`, `HAIKU_NAME:"Claude Haiku 5.5"`. No `PREV_HAIKU_*` constant (unlike `PREV_SONNET_ID` / `PREV_OPUS_ID`). A separate bundled catalog entry still names `claude-haiku-4-5-20251001` / short_name `"Haiku"` / "Fastest for quick answers" — treated as the consumer catalog, not the CLI alias table. Picker-family ownership follows the alias table, same evidence class as Sonnet 5.5 (`docs/plans/add-claude-sonnet-5-5.md`).
- **Picker-family mirror** (`claudeModelPickerFamily`, `src/bun/agents.ts:239`): `haiku-4.5` currently returns `"Haiku"`. 2.1.293's family default is 5.5, so `haiku-5.5` must own `"Haiku"` and `haiku-4.5` must drop to `null`. Gotcha (decision `33e5ee44`, repeated for Sonnet): `reconcileTaskSession` checks the family before the live-session check, so any mirror fixture whose `after.model` is `haiku-4.5` must move to `haiku-5.5`. Grep of `src/**/*.test.ts` found no `after.model` of `haiku-4.5` outside the stdout-sync test that *expects* a Haiku 4.5 sync to stay on `haiku-4.5` (`claude-local-setting.test.ts`) — that one stays.
- **claude-code paired structures**: `AGENT_OPTIONS["claude-code"].models` (`types.ts:3216`), `CLAUDE_MODEL_FLAG` (`agents.ts:169`), `MODEL_EFFORT_SUPPORT["claude-code"]` (`types.ts:2862`, `haiku-4.5: []`), `MODEL_MODE_DENY` (`types.ts:3156`). `CLAUDE_EFFORT_VALUES` (`agents.ts:266`) is `low|medium|high|xhigh|max` and **drops any other id**, including `none`, without setting the env var (`agents.ts:569`). Haiku 4.5's empty effort list stays: `modelDeclinesEffort` still keys off a zero-length support array.
- **Display names** (`claudeModelIdFromDisplayName`, `claude-local-setting.ts:69`): longest `AGENT_OPTIONS` label, word-boundary. Adding label `"Haiku 5.5"` does not steal `"Haiku 4.5"` (different tokens). `"Haiku 4.5.1"` stays unmatched.
- **Cursor — verified live** (`cursor-agent models`, CLI `2026.10.01-14929f9`): ten rows, no `-fast`, **zero labels contain "1M"**.
  - Thinking (unqualified label "Claude Haiku 5.5 &lt;Effort&gt;"): `claude-haiku-5-5-thinking-{low,medium,high,xhigh,max}`
  - No Thinking: `claude-haiku-5-5-{low,medium,high,xhigh,max}` labelled "Claude Haiku 5.5 &lt;Effort&gt; No Thinking"
  - `cursorModelIdCoveredByCatalog` (`types.ts:2685`) hides a discovered id only when it equals a spec, a `fastId`, an `effortIds` value, or `${effortId}-fast`. Listing the thinking ids hides those five and leaves the five No Thinking rows visible as discovered models. That is intentional: agetor has no second thinking toggle, and folding No Thinking into the thinking argv would silently turn thinking on.
- **fx — verified live**: `fx models --json` (0.0.10, unauthenticated, `private_models_hidden: true`, **259 ids**) lists `anthropic/claude-haiku-5.5` and still lists `anthropic/claude-haiku-4.5` and `anthropic/claude-3-haiku`. No `-fast` twin. Public Gateway catalog (`ai-gateway.vercel.sh/v1/models`, 413 entries): `anthropic/claude-haiku-5.5` context 1_000_000, max_tokens 128_000, `reasoning_options: [{type:"toggle"}, {type:"effort", values:["none","low","medium","high","xhigh","max"]}]`. Description: first Haiku with adjustable effort, thinking can be turned off. Haiku 4.5's Gateway entry is toggle + `budget_tokens` only (no effort values) and stays an empty fx effort set.
- **Count pins that move** when one catalogOnly effort-advertising fx row is added (18→19 catalogOnly, 34→35 curated, 21→22 effort, 13 no-effort unchanged): `types.ts` fx prose (`:3353`, `:3397`), `types.test.ts` (`FX_EFFORT_MODELS` length 21, `FX_NO_EFFORT_MODELS` stays 13 and still contains `anthropic/claude-haiku-4.5`, catalogOnly `size` 18, test title "eighteen"), `orchestrator.ts:6086` ("21 of its 34"), `e2e/fx-models.spec.ts:59` ("ten of the eighteen") and `EXCLUDED_FX_OPTION_LABELS`. `agent-discovery.ts` / `fx-acp.ts` "postdates" clauses gain the new id the same way Sonnet 5.5's did.
- **Default-model anchors stay**: `DEFAULT_MODEL["claude-code"]` is `opus-5.5`, `DEFAULT_MODEL.cursor` is `grok-4.7`, `DEFAULT_EFFORT["claude-code"]` is `high`.
- **Migration head**: `061_antigravity_harness` is last in `src/bun/migrations/index.ts`. `migrate.test.ts:710` still asserts **060 is last** (`migrations.length - 1`) — already stale against 061. Registering 062 retargets that assertion.

## 3. Approach & key decisions

Logged because the owner skipped the grill. Each is reversible except the migration, which is additive and idempotent.

1. **`DEFAULT_MODEL["claude-code"]` stays `opus-5.5`.** Haiku 5.5 is a picker row directly above `haiku-4.5`. Cursor default stays `grok-4.7`. Per-kind effort default stays `high`; the row hint states the API's own default is `medium`.
2. **Coexist, not replace.** `haiku-4.5` stays, hint becomes "Prior Haiku release ($1/$5 per MTok). No effort control." Existing tasks stored as `haiku-4.5` are not rewritten.
3. **`haiku-5.5` owns the "Haiku" picker-family row; `haiku-4.5` → `null`.** From the 2.1.293 alias table (`haiku` → `claude-haiku-5-5`), same rule as `sonnet-5.5`.
4. **claude-code effort is `max|xhigh|high|medium|low`, no `none`.** Gateway lists `none`, and the model can turn thinking off, but `CLAUDE_EFFORT_VALUES` drops unknown ids without setting `CLAUDE_CODE_EFFORT_LEVEL` — offering `none` would look selected and spawn at Claude Code's own default. Not probed against the CLI. Haiku 4.5's empty list is unchanged.
5. **Cursor spec `claude-haiku-5-5`** launches the **thinking** variants (`effortIds` → `claude-haiku-5-5-thinking-<effort>`), the rows whose labels are not "No Thinking" (Opus 5 precedent, where thinking ids *are* the effort ids). No `fastEfforts`. **`supportsMaxMode` omitted** — no row is labelled "1M"; a live `[context=1m,…]` probe was not run (Sonnet 5.5's probe confirmed that missing "1M" meant the bracket is rejected). The five No Thinking ids are **not** in `effortIds` and are **not** migrated, so they stay pickable as discovered rows and a stored No Thinking id keeps launching No Thinking.
6. **Migration 062** normalizes only `claude-haiku-5-5-thinking-{max,xhigh,high,medium,low}` on cursor-kind `tasks`, `agent_profiles`, and `lastModel:cursor` into base id `claude-haiku-5-5` + effort, `fast = 0`. Exact `IN (...)` list, not a prefix that could touch `claude-haiku-5-5-low` (No Thinking) or `claude-haiku-4-5`. Frozen `tasks.agent_profile` snapshots untouched; `updated_at` untouched.
7. **fx row `anthropic/claude-haiku-5.5` is `catalogOnly: true`.** Effort `["max","xhigh","high","medium","low","none","auto"]` from the Gateway `reasoning_options` plus fx's always-present `auto`. Not ACP-probed. `anthropic/claude-haiku-4.5` stays `[]`.

## 4. Work breakdown — implementation

**T1 — shared catalogs** (owns `src/shared/types.ts` only)

- Insert `{ id: "haiku-5.5", label: "Haiku 5.5", hint: "Cheapest, fastest Claude ($0.10/$0.50 per MTok up to 100k tokens, $0.50/$2.50 above). 1M context. API default effort is medium." }` directly above `haiku-4.5`. Reword the `haiku-4.5` hint to the prior-release line in §3.2.
- `MODEL_EFFORT_SUPPORT["claude-code"]["haiku-5.5"] = ["max","xhigh","high","medium","low"]` above `haiku-4.5`. Comment: first Haiku with effort; Gateway also lists `none` and a thinking toggle, deliberately not offered on claude-code because `CLAUDE_EFFORT_VALUES` would drop `none` (§3.4). Update the enumerating comment (`:2821`) and the `EFFORT_OPTIONS` xhigh hint (`:2792`) to name Haiku 5.5. Leave the "Haiku 4.5 → effort parameter NOT supported" line (`:2808`) true.
- `MODEL_MODE_DENY["claude-code"]["haiku-5.5"] = []` above `haiku-4.5`.
- `CURSOR_MODEL_SPECS["claude-haiku-5-5"]` immediately before `"claude-sonnet-5-5"`: label "Haiku 5.5", hint "Anthropic Haiku 5.5 via Cursor.", `effortIds` mapping max/xhigh/high/medium/low to `claude-haiku-5-5-thinking-<effort>`, no `fastEfforts`, no `supportsMaxMode`. Comment: measured 2026-10-07 on cursor-agent 2026.10.01; No Thinking siblings `claude-haiku-5-5-<effort>` are intentionally uncovered.
- fx: append `{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", hint: "Premium Gateway tier — offered only when this account's catalog includes it.", catalogOnly: true }` at the end of the catalogOnly block. `MODEL_EFFORT_SUPPORT.fx["anthropic/claude-haiku-5.5"] = ["max","xhigh","high","medium","low","none","auto"]` with a 2026-10-07 Gateway comment (effort values include `none`; also a `toggle`; not ACP-probed). Update count prose: nineteen catalogOnly, 35 curated, 22 of 35 accept effort, 13 no-effort unchanged. Mention the 2026-10-07 unauth catalog (259 ids, id present, no `-fast` twin).
- Acceptance: `bun run typecheck` green.

**T2 — bun driver mapping + prose** (owns `src/bun/agents.ts`, `src/bun/orchestrator.ts`, `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts`, `src/bun/agent-discovery.test.ts` comments only, `CLAUDE.md`)

- `CLAUDE_MODEL_FLAG`: `"haiku-5.5": "claude-haiku-5-5"` above `"haiku-4.5"`.
- `claudeModelPickerFamily`: `case "haiku-5.5": return "Haiku"`; remove the `"haiku-4.5"` case. Extend the doc comment: Haiku follows the same current-release rule because CLI 2.1.293 maps `haiku` → `claude-haiku-5-5` (`HAIKU_ID`), so `haiku-4.5` joins the null bucket.
- `orchestrator.ts` effort-count comment (`:6086`): "22 of its 35" and add `anthropic/claude-haiku-5.5` (2026-10-07) to the Gateway-sourced list; "remaining 13" stays.
- `agent-discovery.ts`, `fx-acp.ts`, `agent-discovery.test.ts`: add `anthropic/claude-haiku-5.5` (curated since 2026-10-07) to the "postdates" clause, same edit Sonnet 5.5 got.
- `CLAUDE.md` fx bullet: nineteen catalog-gated rows, the 35th curated id, Haiku 5.5 joined the effort group on 2026-10-07 (Gateway `reasoning_options` none→max plus toggle; `docs/plans/add-haiku-5-5.md`), and a 2026-10-07 catalog sentence (259 ids on fx 0.0.10, `anthropic/claude-haiku-5.5` present, no `-fast` twin, `mistral/devstral-2` still absent). Picker-family sentence: superseded list includes `haiku-4.5`.
- Acceptance: typecheck green. `grep '"haiku-4.5"' src/bun/agents.ts` shows the flag-table row and no picker-family case.

**T3 — migration 062** (owns `src/bun/migrations/062_normalize_cursor_haiku_5_5.sql`, `src/bun/migrations/index.ts`)

- Clone 060's three UPDATEs over the five thinking ids only. Header comment states why No Thinking ids (`claude-haiku-5-5-low` and siblings) are excluded, and why `fast = 0`. `model = 'claude-haiku-5-5'`. Kind-joined via `harnesses.kind = 'cursor'`. Pref `lastModel:cursor`.
- `index.ts`: import `m062` with `{ type: "text" }` and append `{ id: "062_normalize_cursor_haiku_5_5", sql: m062 }` after 061.
- Acceptance: typecheck green. The migration test lands in T5.

## 5. Work breakdown — tests

**T4 — catalog / driver / effort tests** (owns `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`, `src/shared/types.test.ts`)

- `agents.test.ts`: `buildCommand` `haiku-5.5` → `--model claude-haiku-5-5` and `CLAUDE_CODE_EFFORT_LEVEL` when effort is `high`. `claudeModelPickerFamily("haiku-5.5")` → `"Haiku"` in the current-release test. Move `haiku-4.5` into the null test ("superseded by haiku-5.5 on CLI 2.1.293"). Keep the existing "haiku-4.5 emits no CLAUDE_CODE_EFFORT_LEVEL" test.
- `effort-support.test.ts`: `haiku-5.5` supports xhigh and max and does not include `none`. `haiku-4.5` still returns `[]`. Cursor catalog `toContain("claude-haiku-5-5")` with the cursor default still `grok-4.7`. Ladder `["max","xhigh","high","medium","low"]`. `cursorModelArg("claude-haiku-5-5","low",false)` → `claude-haiku-5-5-thinking-low`. `("…","high",true)` → `claude-haiku-5-5-thinking-high` (no `-fast`). `cursorModelSupportsFast("claude-haiku-5-5","max")` false. `cursorModelSupportsMaxMode("claude-haiku-5-5")` false and `cursorModelArg(…,"xhigh",false,true)` → `claude-haiku-5-5-thinking-xhigh` (no bracket). `cursorModelIdCoveredByCatalog("claude-haiku-5-5-thinking-medium")` true, `("claude-haiku-5-5-medium")` false, `("claude-haiku-5-5-thinking-medium-fast")` true (generic `${variant}-fast` rule).
- `types.test.ts`: `FX_EFFORT_MODELS["anthropic/claude-haiku-5.5"] = ["max","xhigh","high","medium","low","none","auto"]`. Counts 22 / 13 / 35. `anthropic/claude-haiku-4.5` stays in `FX_NO_EFFORT_MODELS`. catalogOnly set gains the id, `size` 19, test titles "nineteen".

**T5 — local-setting, mirror and migration tests** (owns `src/bun/claude-local-setting.test.ts`, `src/bun/migrate.test.ts`, `src/bun/orchestrator-paste-withheld.test.ts` only if a mirror fixture's `after.model` is `haiku-4.5` — none found; do not edit that file unless implementation discovers one)

- `claude-local-setting.test.ts`: `claudeModelIdFromArg("claude-haiku-5-5")` → `haiku-5.5`. Display name `"Haiku 5.5"`, `"Haiku 5.5 (1M context)"`, `"Haiku 5.5 and saved …"` → `haiku-5.5`. Existing `"Haiku 4.5"` fixtures stay, including the empty-effort clear. `"Haiku 4.5.1"` stays null. `parseClaudeLocalSetting` `"Set model to Haiku 5.5 …"` → `{kind:"model", id:"haiku-5.5"}` and `"Kept model as Haiku 5.5"` → `kept: true`.
- `migrate.test.ts`: import 062. Clone the 060 test over the five **thinking** ids (`fast` written 0, including one row seeded `fast=1`). Controls that must be untouched: `claude-haiku-5-5-low` (No Thinking), `claude-haiku-5-5-thinking-minimal` (not a real tier), a `claude-sonnet-5-5-high` cursor row, an fx `anthropic/claude-haiku-5.5` row, a NULL model row. Idempotent re-apply. Replace the "060 is the last registered migration" assertion: **062 is last, immediately after 061**. Keep a separate assertion that 060 still carries alias `057_normalize_cursor_sonnet_5_5` (that part of the old test is still true; the "last" part is already false on this branch because 061 landed without updating it).

**T6 — e2e anchors** (owns `e2e/fx-models.spec.ts`)

- `EXCLUDED_FX_OPTION_LABELS` += `"Claude Haiku 5.5"` with a one-line comment. Prose "ten of the eighteen" → "eleven of the nineteen".
- E2e applies to the picker filter only. Run recipe: `export PATH="$HOME/.bun/bin:$PATH"; bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts`. The harness boots the headless backend; fx stub via `AGETOR_FX_BIN`; no credentials. No new spec file — the claude picker assertion self-derives from `AGENT_OPTIONS`.

## 6. Execution waves

- Wave 1 (parallel, file-disjoint): T1 ∥ T2 ∥ T3. Barrier: `bun run typecheck`.
- Wave 2 (parallel, file-disjoint): T4 ∥ T5 ∥ T6. Barrier: the test tasks in §5.
- Phase 5 review, then Phase 7 `bun run typecheck`, `bun test` filtered to the touched files, and `e2e/fx-models.spec.ts`. Phase 8 only if those fail.

## 7. Blast radius & risks

- `task.model` is a free string. Existing claude `haiku-4.5` rows and fx `anthropic/claude-haiku-4.5` rows are unchanged. Cursor rows holding a **thinking** variant id are rewritten into the shape `cursorModelArg` recomposes. Cursor rows holding a **No Thinking** id are not rewritten and keep launching that id verbatim.
- Demoting `haiku-4.5` from the mirror family: a mid-session dropdown change to Haiku 4.5 posts a next-run breadcrumb instead of driving the picker. Launch argv for a task already on `haiku-4.5` is unchanged.
- No default flip.
- A claude CLI older than 2.1.293 fails `--model claude-haiku-5-5` at spawn the same way any unknown id does. The row hint names no CLI version (Opus 5.5 / Sonnet 5.5 precedent).
- Cursor max mode off: a user cannot request a 1M bracket for this model until the spec flips. No run fails because of a bracket we don't send.
- fx: a signed-in standard catalog may omit `anthropic/claude-haiku-5.5`. `catalogOnly` hides it there. Logged-out discovery distrust still applies.
- `migrate.test.ts`'s "060 is last" assertion is already red against 061. T5 makes 062 the last-migration assertion so the suite can go green; it does not rewrite 061.
- Rollback: revert the change. 062 is safe to leave applied (pre-062 code shows base ids).

## 8. Open questions / assumptions

Owner skipped the grill. These are the calls the plan is built on. Source is named; confidence is about plan shape, not about the measurements in §2.

| # | Question a grill would have asked | Answer used | Source | Confidence |
| --- | --- | --- | --- | --- |
| Q1 | Make Haiku 5.5 the Claude Code default? | No. Stay on `opus-5.5`. | Sonnet 5.5 / Opus 5.5 owner decisions; announcement positions Haiku as the cheap tier | high |
| Q2 | Per-model effort default `medium` (the API default)? | No. Kind default stays `high`. Hint states the API default. | Sonnet 5.5 grill Q2 | high |
| Q3 | Cursor default → Haiku 5.5? | No. Stay on `grok-4.7`. | Sonnet 5.5 grill Q3 | high |
| Q4 | Rewrite stored `haiku-4.5` tasks to 5.5? | No. A stored model is the user's choice. | Opus 5.5 precedent | high |
| Q5 | Which Cursor rows does the spec launch? | Thinking variants. No Thinking rows stay discovered and are not migrated. | Live `cursor-agent models` labels; Opus 5 spec uses thinking ids; hiding No Thinking would remove the only no-thinking path | medium — flip is "point effortIds at the plain ids and migrate those instead" |
| Q6 | Offer effort `none` on claude-code? | No. Picker would lie: `CLAUDE_EFFORT_VALUES` drops `none`. | `agents.ts:266` and `:569`; CLI acceptance of `none` not probed | medium |
| Q7 | fx `catalogOnly`, and include `none` in the fx effort set? | Yes catalogOnly. Yes `none`, because fx sends the value verbatim and the Gateway lists it. | fx catalogOnly rule; Gateway `reasoning_options` measured 2026-10-07; not ACP-probed | medium on the effort set (same caveat Sonnet 5.5 carries) |
| Q8 | `supportsMaxMode`? | Off. No "1M" label. No paid bracket probe. | Label heuristic that the Sonnet 5.5 probe confirmed for that model; this model's bracket was not probed | medium |
| Q9 | Add Haiku 5.5 to Antigravity's hand-listed models? | Out of scope. That catalog bakes effort into the id (`claude-sonnet-5-5-high`) and no Haiku 5.5 id was verified there. | `AGENT_OPTIONS.antigravity` | high |
| A1 | Picker row on 2.1.293 actually selects Haiku 5.5 when the family row is "Haiku" | Assumed from the alias table + `HAIKU_ID`, not from a live `/model` smoke. Stdout sync self-corrects the stored row if the picker lands on Haiku 4.5. | Binary strings, §2 | medium |

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Four claude-code paired structures + `CLAUDE_MODEL_FLAG` | in this run — T1/T2 |
| `claudeModelPickerFamily` supersession + its tests | in this run — T2/T4 |
| Display-name / stdout sync for "Haiku 5.5" vs "Haiku 4.5" | in this run — T5 |
| Cursor thinking-variant spec + migration 062 + migration test, including the already-stale "060 is last" assertion | in this run — T1/T3/T5 |
| No Thinking Cursor ids left as discovered rows | in this run — T1/T4 (covered-by-catalog asserts they stay uncovered). Not a deferred migration. |
| fx catalogOnly row, effort table including `none`, count pins, e2e exclusion label | in this run — T1/T2/T4/T6 |
| `orchestrator.ts` effort-count comment | in this run — T2 |
| `DEFAULT_MODEL` / Cursor default / kind effort default | out of scope — Q1–Q3 |
| Rewrite existing `haiku-4.5` tasks or `lastModel:claude-code` | out of scope — Q4 |
| claude-code effort `none` (would need `CLAUDE_EFFORT_VALUES` plus a CLI probe) | out of scope — Q6; offering it without the env-var change would spawn the wrong effort |
| Cursor `supportsMaxMode` | out of scope pending a bracket probe — Q8; one-line flip |
| Antigravity Haiku 5.5 rows | out of scope — Q9, different harness, ids unverified |
| Retire `mistral/devstral-2` | out of scope — pre-existing Gateway absence |
| `claude-tmux.ts` pane-example comments and historical picker fixtures that quote "Haiku 4.5" as captured text | out of scope — verbatim captures of the parser, same carve-out as Sonnet 5's pane examples. Mirror fixtures are in scope only if `after.model` is `haiku-4.5` (none found) |
| Pre-existing catalogOnly labels missing from `EXCLUDED_FX_OPTION_LABELS` (for example Grok 4.7) | out of scope — not introduced here. The new Haiku 5.5 label is in this run (T6) |
