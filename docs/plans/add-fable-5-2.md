# Plan — Add Fable 5.2 (and Mythos 5.2) to the supported harnesses

| Field | Value |
| --- | --- |
| Date | 2026-11-09 |
| Source | Pipeline task — *"Add Fable 5.2 to the supported harnesses — Claude Code, primarily"* — plus `docs/plans/add-fable-5-2-investigation.md`, `docs/plans/add-fable-5-2-grill.md`, and the grill answers under `docs/plans/add-fable-5-2-grill/round-{1,2}/answers.json` |
| Flags | none |
| Gates | grilled + approved by the owner (2 rounds, 15/15 answered, both one-way doors answered); self-approved for pipeline execution — no interactive approval step remains |
| Status | tests green — test-loop run 2: typecheck clean, 11793/11827 unit+integration pass (4 pre-existing load flakes, green in isolation), fx e2e 5/5, targeted suites 742/742; no product defects found. **Merge with `origin/main` (PR #296):** main's harness-stacks migrations took 084/085 first, so the Cursor normalization migration was renumbered 084 → **086** and re-registered after 085; the plan below names 086, its authored number. |
| Branch | `feature/agetor-add-fable-5-2` |
| Base SHA | `897b70af` (tree clean except the untracked investigation/grill docs) |

## 1. Objective & success criteria

Fable 5.2 (`claude-fable-5-2`, released 2026-11-09) becomes a first-class model in the harnesses that actually serve it — **Claude Code (primary), Cursor, and fx** — with its org-gated twin **Mythos 5.2** added on Claude Code only. Done means every criterion below holds and is proven by the named production path + test:

| # | Success criterion | Production path that produces it | Proof |
| --- | --- | --- | --- |
| 1 | A Claude Code task pinned to `fable-5.2` / `mythos-5.2` launches `--model claude-fable-5-2` / `claude-mythos-5-2`, never the verbatim friendly id | `buildCommand` (`src/bun/agents.ts:642`) → `toClaudeModelArg` → `CLAUDE_MODEL_FLAG` (`:226-241`) | `src/bun/agents.test.ts` buildCommand cases (T6) |
| 2 | The Claude Code picker shows Mythos 5.2, Mythos 5.1, Mythos 5, Fable 5.2, Fable 5.1, Fable 5, then Opus 5.5, with the owner-verbatim hints (below) | `AGENT_OPTIONS["claude-code"].models` (`src/shared/types.ts:4135-4152`) → `mergeModelOptions` → NewTaskForm / RunPanel / TaskLaunchPickers / CLI | `src/shared/types.test.ts` order+copy test (T5); `e2e/fx-models.spec.ts` self-derived Claude list (T10/T11) |
| 3 | Fable 5.2 and Mythos 5.2 offer the full `max→low` effort ladder and every Claude mode | `MODEL_EFFORT_SUPPORT["claude-code"]` (`types.ts:3596-3644`) / `MODEL_MODE_DENY["claude-code"]` (`:4072-4088`) → `supportedEfforts`/`supportedModes` | `src/bun/effort-support.test.ts` (T7) |
| 4 | A mid-session model change to Fable 5.2 drives Claude's bare `/model` Fable row; `fable-5.1` now short-circuits with a next-run breadcrumb | `reconcileTaskSession` (`src/bun/orchestrator.ts:3716-3766`) → `claudeModelPickerFamily` (`agents.ts:313-326`) → `mirrorModelViaPicker` | `src/bun/agents.test.ts` family cases (T6); `src/bun/orchestrator-paste-withheld.test.ts` (T9) |
| 5 | Claude's `Set model to Fable 5.2 …` / `Kept model as Fable 5.2` stdout syncs the task back to `fable-5.2` (and `Fable 5.1` / `Fable 5` still resolve to themselves) | `claudeModelIdFromDisplayName` / `parseClaudeLocalSetting` (`src/bun/claude-local-setting.ts:69-86,223-269`) → `applyClaudeLocalSetting` | `src/bun/claude-local-setting.test.ts` (T6) |
| 6 | Cursor's picker offers Fable 5.2 and composes `claude-fable-5-2-<effort>` / the max-mode bracket, with no fast tier | `CURSOR_MODEL_SPECS["claude-fable-5-2"]` → `AGENT_OPTIONS.cursor.models`, `MODEL_EFFORT_SUPPORT.cursor`, `cursorModelArg`, `cursorModelSupportsMaxMode`, `cursorModelIdCoveredByCatalog` | `src/bun/effort-support.test.ts` + `src/shared/types.test.ts` (T7/T5) |
| 7 | Stored Cursor `claude-fable-5-2-{max,xhigh,high,medium,low}` **and** the pre-existing plain `claude-fable-5-1-*` variants normalize to base id + effort + `speed='off'`, idempotently, on cursor-kind rows only | migration `086` (authored 084) registered in `src/bun/migrations/index.ts` → `migrate()` at boot | `src/bun/migrate.test.ts` (T8) |
| 8 | fx shows "Claude Fable 5.2" as a `catalogOnly` row only when the account's discovered catalog contains `anthropic/claude-fable-5.2`; its effort row is `max,xhigh,high,medium,low,auto`; counts read 27 catalogOnly / 43 curated / 41 effort-advertising | `AGENT_OPTIONS.fx.models` (`types.ts:4347-4390`) / `MODEL_EFFORT_SUPPORT.fx` (`:3767-3846`) → `mergeModelOptions` / `supportedEfforts` | `src/shared/types.test.ts` (T5); `e2e/fx-models.spec.ts` exclusion list (T10) |
| 9 | No regression: typecheck, the six targeted suites, the fx e2e spec, and the full `bun test` are green | whole repo | T11 |

**Owner-verbatim Claude Code copy** (grill §"Exact copy"; do not paraphrase):

1. **Mythos 5.2** — `Fable 5.2's twin — same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
2. **Mythos 5.1** — `Prior Mythos release — Fable 5.1's twin; same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
3. **Mythos 5** — unchanged: `Prior Mythos release — Fable 5's twin; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
4. **Fable 5.2** — `Most capable widely released model — above Opus. Uses 2x the usage of Opus.`
5. **Fable 5.1** — `Prior Fable release — above Opus. Uses 2x the usage of Opus.`
6. **Fable 5** — `Earlier Fable release — above Opus. Uses 2x the usage of Opus.`

The "2x" multipliers stay as written even though Fable/Mythos 5.1 are now 2.5× Opus 5.5 — a recorded owner decision, not a silent deferral (grill decision 5 and §"Exact copy").

## 2. Context & constraints

### 2.1 Model facts (measured, not assumed)

- **Claude Code 2.1.321** ships `claude-fable-5-2` (display `Fable 5.2`) as the default Fable model: 1M context / 128K output, $8/$40 per MTok ($0.20 cache reads — exactly 2× Opus 5.5's $4/$20), effort `low|medium|high|xhigh|max`, API/CLI default `medium`, thinking always on (`rejects_disabled_thinking`). The binary's alias table is `fable.default = claude-fable-5-2` and `latest_per_family.fable = claude-fable-5-2`; the changelog's first 2.1.321 entry names it. Evidence: `claude --version`, binary strings, Claude Code CHANGELOG (investigation §1.2/§2).
- **Mythos 5.2** (`claude-mythos-5-2`) is the same binary metadata, org-gated (Project Glasswing), same price/context/effort.
- **Cursor** `2026.10.22-27dcf5f`, 279 rows: exactly five plain `claude-fable-5-2-{low,medium,high,xhigh,max}` ids, every label containing `1M`; **no `-thinking-`** and **no `-fast`** variants. Same shape as Fable 5.1's plain tier ids (which still have separate `-thinking-` rows).
- **fx 0.0.15**: the unauthenticated catalog (266 ids) and the public Gateway catalog (504 entries) contain `anthropic/claude-fable-5.2` with `reasoning_options` effort low→max, no toggle/none; the owner's signed-in catalog (138 ids today) contains **zero** `anthropic/*` ids, so the curated row must be `catalogOnly`.
- **Copilot 1.0.108** has no Fable 5.2 mention or id; **Antigravity 1.5.1** has no `claude-fable*` id; **OpenCode** already discovers `opencode/claude-fable-5-2`. No rows for those.
- No stored Claude Code data migration is needed: `task.model` is a free string; 227 `fable-5` + 84 `fable-5.1` tasks stay valid. Cursor has **0** stored Fable 5.1/5.2 variant rows on dev/prod today, but 086 still lands for other users and future rows (grill decisions 7–8).

### 2.2 Repo rules that apply (with paths)

- **Adding a model:** extend the relevant `AGENT_OPTIONS.models` array, then teach `buildCommand` the translation — `docs/architecture/harnesses.md:37-39`. Unknown ids pass through verbatim (`:28`), which is why `CLAUDE_MODEL_FLAG` is load-bearing.
- **Picker-family mirror rule:** Claude's bare `/model` picker has one row per family, always the family's *current* release; a pinned id whose family row resolves to a different version must map to `null` — `docs/architecture/harness-claude-code.md:43-44`, doc comment `src/bun/agents.ts:275-312`.
- **`catalogOnly` rule:** fx rows whose signed-in presence is unverified appear only when the harness's discovered catalog positively contains them — `docs/architecture/harness-fx.md:123-130`, `src/shared/types.ts:2758-2778`, `src/shared/model-options.ts`.
- **Cursor spec rule:** a `CURSOR_MODEL_SPECS` entry covers its concrete variant ids (`cursorModelIdCoveredByCatalog`, `types.ts:3445-3451`); covered ids disappear from every picker, so stored rows need the 055/056/060/062/064/076-style normalization — after 072 write `speed`, not `fast`.
- **Copilot floor rule:** only models named in a Copilot CLI changelog get a row/floor — `docs/architecture/harness-copilot.md:69`. Applies as a non-change here.
- **Migration convention:** `src/bun/migrations/index.ts` is the apply order; never reorder/edit applied migrations; next free id was **084** (083 was last at planning time) — main's harness-stacks migrations took 084/085 on merge, so the Cursor normalization shipped as **086** after 085.

### 2.3 Live facts checked for this plan

- `git log -1` → `897b70af` on `feature/agetor-add-fable-5-2`; worktree has **no `node_modules`** (run `bun install` before typecheck/e2e).
- `bun --version` → `1.3.10`.
- Current Fable block, effort/mode tables, Cursor spec, fx rows and every count to be edited were re-read at the current head (§2.4).
- No network/account dependency beyond the local CLIs; the only account-scoped gate is fx `catalogOnly`, which already fails closed.

### 2.4 Anchors at `897b70af` (verify before editing; line numbers drift)

| Surface | Location |
| --- | --- |
| Claude curated models | `src/shared/types.ts:4135-4152` |
| Claude effort table + header | `src/shared/types.ts:3596-3644` |
| Claude mode deny | `src/shared/types.ts:4072-4088` |
| `EFFORT_OPTIONS` xhigh hint | `src/shared/types.ts:3566` |
| `DEFAULT_MODEL` comment (no value change) | `src/shared/types.ts:2822-2828` |
| Cursor specs (Fable 5.1 block) | `src/shared/types.ts:3131-3145` |
| Cursor effort derivation (auto) | `src/shared/types.ts:3699-3704` |
| fx curated rows (Fable 5.1 row) | `src/shared/types.ts:4347-4390` |
| fx effort table (Fable 5.1 row + comment) | `src/shared/types.ts:3720-3846` |
| `AgentOption.catalogOnly` doc | `src/shared/types.ts:2758-2778` |
| fx history comment | `src/shared/types.ts:4320-4346` |
| fx `efforts` comment | `src/shared/types.ts:4396-4404` |
| `CLAUDE_MODEL_FLAG` / `toClaudeModelArg` | `src/bun/agents.ts:226-252` |
| `claudeModelPickerFamily` + doc | `src/bun/agents.ts:275-326` |
| Claude spawn argv | `src/bun/agents.ts:622-642` |
| Model-mirror call site + comment | `src/bun/orchestrator.ts:3716-3766` |
| fx curated-count comment | `src/bun/orchestrator.ts:8579-8586` |
| Fable/Mythos cost callout comment | `src/mainview/components/kanban/NewTaskForm.tsx:1120-1133` |
| Migration registry | `src/bun/migrations/index.ts:113,214` |
| Migrate tests / last-migration pins | `src/bun/migrate.test.ts:2015,2028-2052,2090-2097` |
| fx e2e exclusion list + prose | `e2e/fx-models.spec.ts:60-119,331-333,433-480` |
| Claude docs superseded list | `docs/architecture/harness-claude-code.md:43-44` |
| fx docs counts/ordinals | `docs/architecture/harness-fx.md:72-79,123-130` |
| fx discovery comment | `src/bun/agent-discovery.ts:556-566` (and `agent-discovery.test.ts:329-335`) |
| fx ACP effort comment | `src/bun/fx-acp.ts:512-520` |

## 3. Approach & key decisions

The change is the well-trodden Fable 5.1 / Sonnet 5.5 / Haiku 5.5 shape: **table/switch additions plus one new migration, with no new process, route or network path**. All pickers, CLI commands, effort/mode validation, Cursor arg composition and fx discovery already read these tables.

Decisions (all from the grill; evidence vs. reasoning marked):

| # | Decision | Why | Basis |
| --- | --- | --- | --- |
| D1 | Scope = Claude Code + Cursor + fx (`catalogOnly`) | All three live catalogs serve the model; Copilot/Antigravity do not | evidence (owner accepted) |
| D2 | Add `mythos-5.2` on Claude Code only | CLI ships it as the same model, org-gated; no other catalog has Mythos | evidence (owner overrode the leave-out recommendation) |
| D3 | Keep `opus-5.5` as the default | Fable 5.2 is exactly 2× the usage; a default flip is a separate product decision | evidence (owner accepted) |
| D4 | Keep family-grouped picker order | The list is family-grouped, not globally newest-first | owner |
| D5 | `family-standard` copy: add 5.2 with the current Fable wording, demote 5.1/5, leave multipliers | Owner chose historical multipliers over a copy correction | owner (overrode `family-corrected`) |
| D6 | Mythos copy mirrors Fable | Same family pattern | owner |
| D7 | Include Cursor migration **086** (authored 084) + the Fable 5.1 plain-variant backfill | A spec entry hides the discovered variants; the 5.1 spec shipped without a migration (pre-existing gap) | owner (both one-way doors answered) |
| D8 | fx row `anthropic/claude-fable-5.2`, label "Claude Fable 5.2", generic premium hint, `catalogOnly: true`, effort `max,xhigh,high,medium,low,auto`; no new positive e2e test | Signed-in presence unverified; every other gateway-only row is gated | owner |
| D9 | Cursor spec: five plain ids, `supportsMaxMode: true`, no `fastEfforts`, no thinking ids; no live Cursor spawn probe | Labels carry `1M`; Fable 5.1 is the shape precedent | owner; max mode is inferred (A1) |
| D10 | No `MODEL_MIN_CLI_VERSION['claude-code']` floor | An older CLI fails at spawn on the unknown id, which is the accepted signal | owner/evidence |
| D11 | No Copilot/Antigravity/OpenCode rows; Copilot is a ledger follow-up | Their catalogs do not serve it; OpenCode discovers it dynamically | evidence |
| D12 | No `AGENTS_CONFIG.yml` change | `fable` is a CLI alias that already resolves to 5.2; pinning `claude-fable-5-2` is available to pipelines that need a fixed version | evidence |

Rejected alternatives: adding only Claude Code; flipping the default; putting Fable at the top of the whole picker; correcting the 2x multipliers; adding a Claude CLI floor; adding a fx positive e2e test; live-probing Cursor max mode.

## 4. Work breakdown — implementation tasks

All tasks in a wave own disjoint files. T1–T10 run in parallel after T0; the tests in T5–T10 are written against the exact shapes pinned here, so the wave barrier is green.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T0** | Environment + live-fact preflight | none (untracked `node_modules` only) | — | `bun install` completes and leaves tracked files untouched (`git status` shows only the untracked plan/grill/investigation docs and `node_modules`; revert any `bun.lock` churn and report it); `claude --version` ≥ 2.1.321 and the binary exposes `claude-fable-5-2` / `claude-mythos-5-2`; `cursor-agent models` still lists exactly the five plain `claude-fable-5-2-*` ids with `1M` labels and no `-thinking-`/`-fast`; `HOME=<empty> fx models --json` still contains `anthropic/claude-fable-5.2`; the public Gateway still reports effort low→max. If any id/label changed, **stop and update this plan** before T1 (A1/A6/A7). | external | n/a (preflight) |
| **T1** | Claude Code + Cursor + fx catalogs | `src/shared/types.ts` | T0 | (a) Claude `AGENT_OPTIONS["claude-code"].models` first six ids are exactly `mythos-5.2, mythos-5.1, mythos-5, fable-5.2, fable-5.1, fable-5`, with the §1 verbatim hints. (b) `MODEL_EFFORT_SUPPORT["claude-code"]["fable-5.2"|"mythos-5.2"]` = `["max","xhigh","high","medium","low"]`. (c) `MODEL_MODE_DENY["claude-code"]` lists both new ids with `[]` (source check), and `supportedModes("claude-code", "fable-5.2"|"mythos-5.2")` returns all five modes. (d) `CURSOR_MODEL_SPECS["claude-fable-5-2"]` is label "Fable 5.2", hint "Anthropic Fable 5.2 via Cursor.", `supportsMaxMode: true`, `effortIds` = the five plain ids, no `fastEfforts`, inserted immediately above `claude-fable-5-1`. (e) fx has the `anthropic/claude-fable-5.2` row (`catalogOnly: true`, generic premium hint) directly above 5.1, the effort row above 5.1, and the counts/comments updated to 27/43/41. (f) `EFFORT_OPTIONS` xhigh hint and the `DEFAULT_MODEL` comment name Fable 5.2 and Mythos 5.2; the default value is untouched. `bun run typecheck` green; `bun -e` assertions on (a)–(e) pass. | none | every picker via `mergeModelOptions`; `supportedEfforts`/`supportedModes`; `cursorModelArg`/`cursorModelIdCoveredByCatalog`; fx discovery/merge |
| **T2** | Claude argv + picker family + supersession comments | `src/bun/agents.ts`, `src/bun/orchestrator.ts`, `src/mainview/components/kanban/NewTaskForm.tsx` | T0 | (a) `CLAUDE_MODEL_FLAG` gains `mythos-5.2 → claude-mythos-5-2` and `fable-5.2 → claude-fable-5-2` above 5.1. (b) `claudeModelPickerFamily("fable-5.2") === "Fable"`; `("fable-5.1") === null`, `("fable-5") === null`, `("mythos-5.2") === null`; doc comment records CLI 2.1.321's alias table + supersession. (c) `orchestrator.ts` mirror comment names the superseded `fable-5.1` and the Mythos set; `NewTaskForm` comment says `(5, 5.1, 5.2, …)`. `bun run typecheck` green; a `bun -e` check of `toClaudeModelArg`/`claudeModelPickerFamily` passes. | state | `buildCommand` (`agents.ts:642`) and `reconcileTaskSession` (`orchestrator.ts:3736-3742`) |
| **T3** | Cursor migration 086 (authored 084) + registration | `src/bun/migrations/086_normalize_cursor_fable_5_2.sql` (new), `src/bun/migrations/index.ts` | T0 | 086 has three kind-joined blocks for 5.2 and three for the 5.1 plain backfill: `tasks` (agent ∈ cursor harnesses), `agent_profiles` (harness_id ∈ cursor harnesses), `preferences` (`lastModel:cursor`). Explicit IN lists only; `speed='off'`; `updated_at` and frozen snapshots untouched; `-thinking-*` ids never match; one-way and idempotent. Registered last (`import m086` after m085, entry after 085; renumbered from 084 on merge with main's harness-stacks migrations). A `bun -e` smoke on an in-memory DB folds `claude-fable-5-2-high` and `claude-fable-5-1-low`, leaves `claude-fable-5-1-thinking-high`/non-cursor/base ids alone, and a second exec is a no-op. | migration, data | `migrate()` at boot via the registry |
| **T4** | Comment/doc sync | `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts`, `src/bun/agent-discovery.test.ts`, `docs/architecture/harness-claude-code.md`, `docs/architecture/harness-fx.md` | T0 | Claude doc's superseded list adds `fable-5.1`. fx doc's effort history gains a dated 2026-11-09 sentence (no invented ordinal), counts read 41 of 43 / 16 standard + 27 catalogOnly / 43 curated, and the curated list names `claude-fable-5.2`. The two source comments add the id to their "postdates this measurement" lists. `grep -n "42 curated\|twenty-six\|40 of the 42" docs/architecture/harness-fx.md` returns nothing; `bun run typecheck` still green. | none | docs only |
| **T5** | Catalog unit tests | `src/shared/types.test.ts` | T0 | Claude order/copy test (first six ids + the six verbatim hints); fx `FX_EFFORT_MODELS` gains 5.2 → `["max","xhigh","high","medium","low","auto"]`; counts 40→41 / 42→43; `expectedCatalogOnly` gains the id and size becomes 27; test names "twenty-six"→"twenty-seven", "40 of the 42"→"41 of the 43"; `CURSOR_MODEL_SPECS` structural check for 5.2. `bun test src/shared/types.test.ts` green and each new assertion fails when its row is removed. | tests | wave barrier |
| **T6** | Claude argv/mirror/stdout tests | `src/bun/agents.test.ts`, `src/bun/claude-local-setting.test.ts` | T0 | buildCommand cases for `fable-5.2` and `mythos-5.2`; family test moves `fable-5.1` to the null bucket with a comment, adds `fable-5.2 → "Fable"` and `mythos-5.2 → null`; `claudeModelIdFromArg("claude-fable-5-2") → "fable-5.2"` (and the mythos analog); display-name cases `"Fable 5.2"`, `"Fable 5.2 (1M context)"`, `"Mythos 5.2"`, plus no-conflation checks against `"Fable 5.1"`/`"Fable 5"`; `Set model to Fable 5.2 …` / `Kept model as Fable 5.2` parse cases. `bun test src/bun/agents.test.ts src/bun/claude-local-setting.test.ts` green. | tests | wave barrier |
| **T7** | Effort/Cursor composition tests | `src/bun/effort-support.test.ts` | T0 | Claude `fable-5.2`/`mythos-5.2` contain xhigh+max; Cursor `supportedEfforts("cursor","claude-fable-5-2")` = `["max","xhigh","high","medium","low"]`; `cursorModelArg(...,"xhigh",false)` = `claude-fable-5-2-xhigh`; fast never composes / `cursorModelSupportsFast` false; max-mode bracket = `claude-fable-5-2[context=1m,effort=xhigh]`; `cursorModelSupportsMaxMode` true; `cursorModelIdCoveredByCatalog("claude-fable-5-2-high")` true and `("claude-fable-5-2-thinking-high")` false. `bun test src/bun/effort-support.test.ts` green. | tests | wave barrier |
| **T8** | Migration 086 tests | `src/bun/migrate.test.ts` | T0 | Import 086 SQL; a 076-shaped test covering all ten plain variants (5.2 + 5.1) on cursor tasks/profiles and `lastModel:cursor`, with controls for base ids, `-thinking-` ids, fx gateway ids, other kinds, unknown suffixes, orphan harnesses, NULL model, `lastEffort:cursor`; second run is a no-op. Last-migration pin rewritten to 086 (085 precedes; no aliases; SQL contains both families); the exact `migrate(db, migrations)` lists at `:2015`, `:2041`, `:2090-2097` gain 084-086. `bun test src/bun/migrate.test.ts` green. | tests, migration | wave barrier |
| **T9** | Live-mirror regression tests | `src/bun/orchestrator-paste-withheld.test.ts` | T0 | The "target not offered" fixture moves `after.model` from `fable-5.1` to `fable-5.2` (5.1 now returns null before the picker) and its status assertion names fable-5.2; add a dedicated "superseded `fable-5.1` never drives the picker — next-run breadcrumb, no paste" test mirroring the `opus-5` one (create on `sonnet-5`, change to `fable-5.1`, expect no `load-buffer`/`send-keys` and `model fable-5.1 applies on the next run — claude's picker can't select it for this session`). `bun test src/bun/orchestrator-paste-withheld.test.ts` green. | tests, state | wave barrier |
| **T10** | fx e2e exclusion list + prose | `e2e/fx-models.spec.ts` | T0 | `EXCLUDED_FX_OPTION_LABELS` gains `"Claude Fable 5.2"` with a dated comment; the module prose becomes "nineteen of the twenty-seven catalogOnly premium rows" (re-count from the file); the existing positive Fable 5.1 test and the self-derived Claude list stay. `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` green (one Playwright invocation at a time). | tests, external | wave barrier |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T5 | unit | Claude catalog order/copy; fx effort row, counts, catalogOnly set; Cursor spec shape | `src/shared/types.test.ts` | Green; red against a removed row |
| T6 | unit | `CLAUDE_MODEL_FLAG` (both directions), picker family, display-name/parse | `src/bun/agents.test.ts`, `src/bun/claude-local-setting.test.ts` | Green; red against a missing flag/label |
| T7 | unit/integration | effort ladders, Cursor arg composition, max mode, coverage | `src/bun/effort-support.test.ts` | Green; red against `supportsMaxMode: false` |
| T8 | integration/migration | 086 tasks/profiles/prefs, kind join, idempotency, registry order | `src/bun/migrate.test.ts` | Green; red against a missing UPDATE block |
| T9 | integration | live-session mirror: Fable 5.2 drives, Fable 5.1 short-circuits, "target not offered" | `src/bun/orchestrator-paste-withheld.test.ts` | Green; red against `fable-5.1 → "Fable"` |
| T10 | e2e | fx picker convergence/exclusion; self-derived Claude picker list | `e2e/fx-models.spec.ts` | Green; red if the 5.2 row leaks into the frozen 4-id stub list |
| T11 | verification | all layers + the full suite | none (fix-round only; may update this plan's `Status`) | All commands below green; flaky tmux tests re-run once and reported; update this plan's `Status` to `tests green` and record command output/counts in the hand-off |

**E2e applicability: applies.** The change is user-visible in pickers and crosses UI → API → discovery, and the app runs locally with an existing harness. The existing `e2e/fx-models.spec.ts` already asserts the self-derived Claude list and the fx convergence; it needs the exclusion-list/prose update, not a new spec. No new positive Fable 5.2 e2e test (owner D8).

**Run recipe:**
1. `bun install` (the worktree has no `node_modules`).
2. Unit/integration: `bun test src/shared/types.test.ts src/bun/agents.test.ts src/bun/effort-support.test.ts src/bun/claude-local-setting.test.ts src/bun/migrate.test.ts src/bun/orchestrator-paste-withheld.test.ts`.
3. E2e: `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` — one Playwright invocation at a time; it boots its own headless backend and uses the frozen fx stub, so no credentials/seed data are needed. Never point a manual smoke at `~/.agetor`; use `AGETOR_DATA_DIR="$HOME/.agetor-dev" AGETOR_API_PORT=4318 bun run dev:hmr` if one is needed.
4. Full suite: `bun test` (re-run known flaky tmux tests once at high load).
5. Typecheck: `bun run typecheck`.

## 6. Execution waves

- **Wave 0 (sequential, blocking): T0** — install deps and re-probe the three live catalogs. If any id/label changed, amend this plan before T1.
- **Wave 1 (parallel, file-disjoint): T1, T2, T3, T4, T5, T6, T7, T8, T9, T10.** No path appears twice. Barrier: `bun run typecheck` + the six targeted suites green; checkpoint commit `feat: add Fable 5.2 to Claude Code, Cursor and fx`.
- **Wave 2 (sequential): T11** — run the e2e spec, full `bun test`, re-check the owner copy and the counts, and record pass/fail + flaky re-runs. Any failure goes back to its owning task's file in a fix micro-wave, then T11 re-runs.
- **Delivery:** one PR. Estimated diff ~600–800 lines including tests/docs — well under the 1,500-line review threshold, and the migration is additive. No PR stack.

## 7. Invariants, runtime shape & risks

**Invariants (each has one enforcement point):**
- *Every Claude Code curated id launches with its exact CLI id* — enforced at `CLAUDE_MODEL_FLAG` via `toClaudeModelArg`; `buildCommand` (`agents.ts:642`) and the orchestrator's alias check (`orchestrator.ts:3992`) both route through it. No other argv path.
- *Only the current release per family drives the live `/model` mirror* — enforced at `claudeModelPickerFamily`; every new id either owns a family row (`fable-5.2`) or returns `null` (`fable-5.1`, `mythos-5.2`).
- *A spec-covered Cursor variant is never left stored* — enforced by 086 for the ids the new/old Fable specs cover; `cursorModelIdCoveredByCatalog` is the single coverage test; every picker hides covered ids.
- *`catalogOnly` rows appear only on positive discovery* — enforced at `mergeModelOptions` for `CATALOG_SCOPED_KINDS` (fx/opencode); no new path introduces a second gate.
- *Migrations apply in index order, one-way, idempotent* — enforced at `src/bun/migrations/index.ts` + `migrate()`.

**Runtime shape:** agetor is a local desktop app (Bun core + webview) over a localhost, token-authenticated HTTP API; one core per data dir; SQLite storage. This change adds no process, route, network peer or trust boundary — model rows are static local config. There is no rolling deploy/crash-between-steps concern; `migrate()` runs at boot and 086 is a set of idempotent UPDATEs. fx discovery-empty/logged-out hides the new `catalogOnly` row (fail closed) rather than breaking a run. No kill switch is needed; the change is additive config.

**Blast radius:** every picker (New Task, RunPanel task details, TaskLaunchPickers, CLI `add`/`edit`/`profile`), `buildCommand`, the live-session mirror, display-name/stdout sync, effort/mode validation, Cursor spec-derived surfaces (picker, effort, arg, coverage, discovery filter), fx discovery/merge/effort, and the named docs/comments. Usage accounting is model-name-agnostic; bundles/profiles store ids verbatim; frozen `tasks.agent_profile` / `tasks.pipeline_run` snapshots are not rewritten.

**Rollback:** revert the commit(s); the new rows/spec/flag are additive, no Claude data is mutated. Migration 086 is one-way like 055/056/060/062/064/076 — reversing it means a new migration, not a down-migration.

**Cross-repo dependencies:** none. External CLI versions the facts rest on: claude 2.1.321, cursor-agent 2026.10.22-27dcf5f, fx 0.0.15.

## 8. Open questions / assumptions

No unratified one-way doors — both (Cursor migration 086 and the Fable 5.1 backfill) were answered by the owner. Proceeding on the grill's assumptions:

- **A1 — Cursor max mode works for Fable 5.2.** Inferred from every 5.2 label containing "1M" plus Fable 5.1's `supportsMaxMode: true`; no live `claude-fable-5-2[context=1m,effort=…]` spawn probe was run. If rejected, the fix is one flag + one assertion.
- **A2 — Claude 2.1.321's bare `/model` Fable row resolves to Fable 5.2.** Proven indirectly (alias table, `latest_per_family`, changelog), not smoked through the live picker. If it still lands on 5.1, the stdout sync self-corrects with a breadcrumb; no corruption.
- **A3 — fx's effort set is `[max,xhigh,high,medium,low,auto]`.** Public Gateway `reasoning_options` + fx's always-present `auto`; not ACP-probed. The driver degrades to a status breadcrumb, never a failed turn.
- **A4 — Copilot will add Fable 5.2 later.** Today's 1.0.108 has no mention/id; re-check when its changelog names it.
- **A5 — No Claude Code CLI floor.** An older CLI fails at spawn on the unknown id; the exact-keys test in `effort-support.test.ts:223-225` stays untouched.
- **A6 — The Cursor catalog measured 2026-11-09 may change.** T0 re-runs `cursor-agent models`; if the five ids or `1M` labels changed, adjust the spec and 086 before coding.
- **A7 — The Claude ids are from CLI 2.1.321.** If a later CLI renames them, `CLAUDE_MODEL_FLAG` and the effort tables move with it.
- **A8 — Migration 086 (authored 084) is one-way.** Additive/normalizing and data-clean on this machine (zero stored variant rows), but other users may have rows; rollback is a new migration.
- **A9 — `fable` is a CLI alias, not an agetor version pin.** Pipelines needing a fixed version should pin `claude-fable-5-2` explicitly.
- **A10 — The fx row is invisible on the owner's signed-in account.** Its catalog has zero `anthropic/*` ids; the row appears only for accounts whose discovered catalog contains it.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Claude Code `fable-5.2` + `mythos-5.2` curated rows, verbatim copy, picker order | In this run | T1, T5 |
| Claude Code `CLAUDE_MODEL_FLAG` entries + `toClaudeModelArg` | In this run | T2, T6 |
| Claude Code effort/mode entries + `EFFORT_OPTIONS` xhigh hint | In this run | T1, T7 |
| Picker-family supersession (`fable-5.2` owns Fable; `fable-5.1` → null) + mirror comment | In this run | T2, T6, T9 |
| Display-name / `Set model to` stdout sync | In this run | T6 (code already generic) |
| Cursor `CURSOR_MODEL_SPECS["claude-fable-5-2"]` | In this run | T1, T5, T7 |
| Cursor migration 086 (authored 084; 5.2 variants + 5.1 plain backfill + `lastModel:cursor`) | In this run | T3, T8 |
| fx `catalogOnly` row + effort row | In this run | T1, T5 |
| fx counts 26→27 / 42→43 / 40→41 across code, tests, docs | In this run | T1, T4, T5, T10 |
| `e2e/fx-models.spec.ts` exclusion list + prose | In this run | T10 |
| `docs/architecture/harness-claude-code.md` superseded list | In this run | T4 |
| `docs/architecture/harness-fx.md` counts/ordinals | In this run | T4 |
| `src/bun/agent-discovery.ts` / `fx-acp.ts` measurement comments | In this run | T4 |
| Typecheck + targeted tests + fx e2e + full `bun test` | In this run (acceptance) | T11 |
| Copilot Fable 5.2 row/floor | Out of scope — different ticket | `@github/copilot` 1.0.108 has no mention/id; follow up when its changelog names it (grill D11) |
| Antigravity Fable 5.2 | Out of scope — different ticket | 1.5.1 binary carries no `claude-fable*` id; the harness has never carried Fable |
| OpenCode Fable 5.2 | No work — already covered | `opencode models` lists `opencode/claude-fable-5-2`; discovery appends it |
| Codex / Gemini | Not applicable | Non-Anthropic catalogs |
| Existing `fable-5` / `fable-5.1` Claude tasks | No migration | `task.model` is a free string; both ids remain valid CLI models |
| Fable/Mythos 5.1 "2x" multiplier correction | Owner-deferred (declined) | grill decision 5 chose `family-standard`; recorded, not silently deferred |
| README default-model row | No change | Default stays `opus-5.5` |
| `AGENTS_CONFIG.yml` / pipeline alias | No change | `fable` resolves to 5.2 inside the CLI |
| `CLAUDE.md` | No change | No Fable-specific text |
| `MODEL_MIN_CLI_VERSION` | Explicit non-change | No Claude Code entry (A5) |
| Live Cursor spawn probe | Explicit non-change | Inferred max mode (A1) |
| `e2e/agent-profiles-launch.spec.ts` | No change | Default stays Opus 5.5 |
| `src/bun/agent-discovery.test.ts` fx fixture payloads | No change | Historical probe shapes stay byte-identical; T4 only refreshes the comment |
| `docs/architecture/harness-copilot.md`, `harness-cursor.md` | No change | No row/floor/list to update |
| `src/bun/usage/claude-usage.ts` | No change | Model-name-agnostic |
