# Investigation — Add Claude Fable 5.2 to the supported harnesses

| Field | Value |
| --- | --- |
| Date | 2026-11-09 |
| Change | Add Claude **Fable 5.2** (`claude-fable-5-2`, released 2026-11-09) to every agetor harness catalog that actually offers it — **claude-code first**, then Cursor and fx if the live catalogs confirm them. The brief informs harness scope, picker-family supersession, Cursor variant migration, fx `catalogOnly`/count updates, tests and docs. |
| Agents | none — this pipeline step explicitly says "do not spawn subagents"; all probes were run inline. |
| Flags | none — no spikes were needed; every load-bearing fact was settled by a live CLI/catalog probe or source inspection. |
| Branch / base | `feature/agetor-add-fable-5-2` @ `897b70af` (tree clean) |
| Precedents | `docs/plans/claude-code-fable-5-1-mythos-5-1.md` (same Fable-family supersession), `docs/plans/add-claude-sonnet-5-5.md` and `docs/plans/add-haiku-5-5.md` (Claude Code + Cursor spec/migration + fx `catalogOnly`), `docs/plans/add-claude-opus-5-5.md` (full example-driven plan shape). |

## 1. What we know

### 1.1 Contract and standards

- **Contract:** there is no PRD or spec in the repo for this change. The task title — *"Add Fable 5.2 to the supported harnesses — Claude Code, primarily"* — is the contract. The precedent plans above are the de-facto acceptance contract: a new model is "supported" when it has a curated row, correct launch argv, effort/mode coverage, a picker-family mirror decision, the same row in every harness catalog that serves it, and tests that pin those facts.
- **Repo rule for adding a model:** `docs/architecture/harnesses.md:37-39` — extend the relevant `AGENT_OPTIONS.models` array, then teach `buildCommand` how to translate it (or rely on verbatim passthrough). The curated lists shown in every picker are `AGENT_OPTIONS` in `src/shared/types.ts`.
- **Unknown model ids pass through verbatim** (`docs/architecture/harnesses.md:28`). For claude-code this is exactly why the `CLAUDE_MODEL_FLAG` entry is load-bearing: without it, `buildCommand` emits `--model fable-5.2` instead of `--model claude-fable-5-2`.
- **Picker-family mirror rule:** `docs/architecture/harness-claude-code.md:43-44` — claude's bare `/model` picker offers one row per family, always the family's *current* release. A pinned id whose family row would resolve to a different version must map to `null` (next-run breadcrumb only) rather than silently switching versions. Fable 5, then Fable 5.1, already followed this rule; Fable 5.2 is the next supersession.
- **`catalogOnly` rule:** `docs/architecture/harness-fx.md:123-130` — an fx Gateway row is `catalogOnly` when it is a premium/account-scoped id whose presence in a standard signed-in catalog is unverified. `catalogOnly` rows appear only when the harness's discovered catalog positively contains them.
- **Cursor spec rule:** a `CURSOR_MODEL_SPECS` entry "covers" its concrete variant ids (`cursorModelIdCoveredByCatalog`, `src/shared/types.ts:3445-3451`); every picker hides the now-covered discovered rows, so a stored variant id needs a migration that folds it into base id + effort (and speed) — the 055/056/060/062/064/076 convention. Migrations after 072 write `speed`, not `fast`.
- **Copilot floor rule:** `docs/architecture/harness-copilot.md:69` — `MODEL_MIN_CLI_VERSION.copilot` holds the first stable CLI version whose changelog mentions the model. A model with no changelog mention does not get a row.
- **Antigravity rule:** `docs/architecture/harness-antigravity.md:14` — its catalog is hand-listed with effort baked into the id; discovery appends discovered-only rows. It only gets models its own catalog serves.

### 1.2 Fable 5.2 — the model

The installed Claude Code CLI (2.1.321) and its published changelog both carry the model:

- **Identity:** `claude-fable-5-2`. Display name `Fable 5.2` (`Claude Fable 5.2` in prose).
- **Release:** 2026-11-09 (the Claude Code 2.1.321 changelog's first entry; the Vercel AI Gateway `released` timestamp is 2026-11-09).
- **Positioning:** "the newest model in Anthropic's Claude 5 family and part of the Mythos-class model tier that sits above Claude Opus"; "our most intelligent generally available model". Fable 5.2 and **Mythos 5.2** share the same underlying model; Mythos 5.2 is the approved-org (Project Glasswing) variant without the dual-use safety measures.
- **Context / output:** 1M context, 128K max output.
- **Price:** $8 / $40 per MTok input/output, $0.20/Mtok cache reads; cache writes $10 (5m) / $16 (1h). This is exactly 2× Opus 5.5's $4/$20 and cheaper than Fable 5.1's $10/$50.
- **Effort:** full `low | medium | high | xhigh | max` ladder; API/CLI default effort is `medium`; `xhigh` and `max` are supported (`max_effort`, `xhigh_effort` capabilities). Thinking is always on — `rejects_disabled_thinking`; no `none` row on claude-code.
- **Fable alias:** the binary's alias table is `fable: { default: "claude-fable-5-2", per_provider: { gateway: "claude-fable-5" } }`; `latest_per_family.fable` is `claude-fable-5-2`. The changelog says it is "now the default Fable model" and that saved Fable 5.1 picks move to `fable` (use `/model claude-fable-5-1` to switch back). The gateway carve-out does not affect agetor: it spawns the local first-party CLI, not a Claude apps gateway session (same carve-out Fable 5.1 documented).
- **Prior releases:** Fable 5 and Fable 5.1 are still served; Fable 5.1 remains explicitly selectable via `/model claude-fable-5-1`. No retirement entry exists.
- **Mythos 5.2:** the same binary metadata exists (`claude-mythos-5-2`, display `Mythos 5.2`, same context/pricing/effort, org-gated). The task names only Fable 5.2; whether to add the twin is an owner decision (§4 Q2).

Evidence:
- `claude --version` → `2.1.321 (Claude Code)`.
- Binary strings: `FABLE_ID:"claude-fable-5-2"`, `FABLE_NAME:"Claude Fable 5.2"`, `PREV_FABLE_ID:"claude-fable-5-1"`, `MYTHOS_ID:"claude-mythos-5-2"`, the `fable` alias object and `latest_per_family` above.
- Binary model metadata for `claude-fable-5-2`: `pricing:"tier_8_40_cache_read_0_20"`, `context:{window:1e6,native_1m:true,…}`, `max_output_tokens:{default:128000,upper:128000}`, capabilities `effort`, `max_effort`, `xhigh_effort`, `adaptive_thinking`, `rejects_disabled_thinking`, `default_effort:"medium"`.
- Claude Code changelog 2.1.321 (first entry): *"Added Claude Fable 5.2 (`claude-fable-5-2`), now the default Fable model — 1M context, $8/$40 per Mtok with $0.20/Mtok cache reads"*.

### 1.3 Harness support matrix

| Harness | Fable 5.2 available? | Evidence | Action |
| --- | --- | --- | --- |
| **claude-code** | **Yes** | CLI 2.1.321 binary alias/metadata + changelog 2.1.321 | **Required:** curated row, `CLAUDE_MODEL_FLAG`, effort/mode maps, picker-family supersession, display-name tests |
| **Cursor** | **Yes** | `cursor-agent models` 2026.10.22-27dcf5f, 279 rows: five `claude-fable-5-2-{low,medium,high,xhigh,max}` rows, labels `Claude Fable 5.2 1M … (NO ZDR)`; no `-thinking-`, no `-fast` | **Recommended:** `CURSOR_MODEL_SPECS` entry + variant-id migration (084) |
| **fx** | **Yes, account-scoped** | public Gateway 504-model catalog and `HOME=<empty> fx models --json` (0.0.15, 266 ids) both contain `anthropic/claude-fable-5.2`; the owner's signed-in catalog (138 ids) contains **zero** `anthropic/*` ids | **Recommended:** `catalogOnly` row + effort table entry |
| **GitHub Copilot** | **No evidence yet** | npm latest `@github/copilot` 1.0.108 (2026-11-09); changelog mentions `claude-fable-5.1` at 1.0.83 and `Claude Fable 5` earlier, **never Fable 5.2**; the darwin-arm64 binary contains no `claude-fable*` id | **No change now.** Follow-up when a Copilot CLI changelog mentions it (then add row + floor, per `harness-copilot.md:69`) |
| **Antigravity** | **No** | cask `antigravity-cli` 1.5.1 binary carries `claude-opus-5-5-*` and `claude-sonnet-5-5-*` ids but **no** `claude-fable*` id | **No change** |
| **OpenCode** | **Yes, dynamically** | `opencode models` (v2.1.3) already lists `opencode/claude-fable-5-2` (the OpenCode Zen provider); OpenCode is catalog-scoped and has only the pinned "OpenCode default" curated row | **No code change.** Discovery appends it (or an Anthropic-provider id) automatically |
| **Codex** | No | Codex runs OpenAI models only; no Anthropic ids | N/A |
| **Gemini** | No | Gemini CLI runs Google models only; no Anthropic ids | N/A |

The phrase "supported harnesses" therefore resolves to **claude-code + Cursor + fx** for code changes; OpenCode is already supported by discovery, and Copilot/Antigravity genuinely do not offer the model today.

### 1.4 Claude Code surfaces (the primary change)

- **Curated models:** `AGENT_OPTIONS["claude-code"].models` at `src/shared/types.ts:4135-4152`. Current Fable block:
  - `fable-5.1` — `"Most capable widely released model — above Opus. Uses 2x the usage of Opus."`
  - `fable-5` — `"Prior Fable release — above Opus. Uses 2x the usage of Opus."`
  - Mythos rows sit above Fable (`mythos-5.1`, `mythos-5`).
- **Launch mapping:** `CLAUDE_MODEL_FLAG` at `src/bun/agents.ts:226-241`; `toClaudeModelArg` at `:250-252`. Missing entry → wrong argv `--model fable-5.2`.
- **Picker family:** `claudeModelPickerFamily` at `src/bun/agents.ts:313-326`; doc comment `:275-312`. Today `"fable-5.1"` returns `"Fable"`; `"fable-5"` returns `null`.
- **Effort:** `MODEL_EFFORT_SUPPORT["claude-code"]` at `src/shared/types.ts:3605-3644`; current Fable rows are full `["max","xhigh","high","medium","low"]`. The table's header comment at `:3597-3604` and the `EFFORT_OPTIONS` xhigh hint at `:3566` enumerate the supported generations.
- **Modes:** `MODEL_MODE_DENY["claude-code"]` at `src/shared/types.ts:4072-4088`; every claude row is `[]`.
- **Defaults:** `DEFAULT_MODEL["claude-code"]` stays `"opus-5.5"` (`src/shared/types.ts:2822-2828`); `DEFAULT_EFFORT["claude-code"]` stays `"high"` (`:2907-2908`). Fable is a 2×-usage premium tier, so the house rule keeps the default off it unless the owner says otherwise.
- **Display-name / stdout sync:** `claudeModelIdFromDisplayName` at `src/bun/claude-local-setting.ts:69-86` matches the longest `AGENT_OPTIONS` label with a word-boundary guard. Adding `"Fable 5.2"` is safe against `"Fable 5.1"` and `"Fable 5"`; the parser at `:223-269` then resolves `Set model to Fable 5.2 …` / `Kept model as Fable 5.2` generically.
- **UI premium callout:** `NewTaskForm.tsx:1120-1136` already uses `model?.startsWith("fable-")` / `startsWith("mythos-")`, so a new Fable row gets the "uses 2x the usage of Opus" callout automatically. No code change; the comment says "(5, 5.1, …)" and can be refreshed.
- **Not touched:** `claude-tmux.ts` family matching is by the row's leading word (`Fable`), not its version; the mirror and all generic pickers need no code change.

### 1.5 Cursor (measured live)

`cursor-agent models` on CLI `2026.10.22-27dcf5f` returns **279 rows**. The Fable 5.2 block is exactly five plain effort ids:

```
claude-fable-5-2-low     - Claude Fable 5.2 1M Low (NO ZDR)
claude-fable-5-2-medium  - Claude Fable 5.2 1M Medium (NO ZDR)
claude-fable-5-2-high    - Claude Fable 5.2 1M (NO ZDR)
claude-fable-5-2-xhigh   - Claude Fable 5.2 1M Extra High (NO ZDR)
claude-fable-5-2-max     - Claude Fable 5.2 1M Max (NO ZDR)
```

- **No `claude-fable-5-2-thinking-*` variants** (unlike Fable 5.1, which still has them).
- **No `claude-fable-5-2-fast` variants** (same as Fable 5.1 and Fable 5).
- Every label contains **1M**, so `supportsMaxMode: true` matches the Fable 5.1 spec; the max-mode bracket shape is `claude-fable-5-2[context=1m,effort=<effort>]` with no `fast=` component.
- The catalog has **no Mythos** ids at all.
- A spec entry at `src/shared/types.ts` immediately before `claude-fable-5-1` (`:3134-3145`) makes `AGENT_OPTIONS.cursor.models` and `MODEL_EFFORT_SUPPORT.cursor` derive automatically; `cursorModelArg`, `cursorModelSupportsFast`/`MaxMode` and `cursorModelIdCoveredByCatalog` also derive.
- **Migration:** adding the spec hides the five discovered variant rows from every picker. The repo's convention (055/056/060/062/064/076) is a kind-joined normalization into base id + effort + `speed='off'` for cursor-kind `tasks`, `agent_profiles`, and `lastModel:cursor`. Next free number is **084**. Note that Fable 5.1's own spec was added without such a migration; that is a pre-existing gap worth a decision (§4 Q4).

### 1.6 fx (measured live)

- Installed `fx` is **0.0.15**; `fx models --json` with the real signed-in HOME returns **138 ids** and **zero** `anthropic/*` ids.
- `HOME=<empty> fx models --json` returns **266 ids**, including `anthropic/claude-fable-5.2` (and 18 `anthropic/*` ids total).
- The public Gateway catalog (`https://ai-gateway.vercel.sh/v1/models`, 504 entries) has `anthropic/claude-fable-5.2`:
  - name "Claude Fable 5.2", context 1,000,000, max_tokens 128,000, released 2026-11-09;
  - `reasoning_options: [{type:"effort", values:["low","medium","high","xhigh","max"]}]` — no `toggle`, no `none`;
  - $8/$40 per MTok, $0.20/Mtok cache read;
  - a `-batch` twin exists (discovery-only, as with every other `-batch`/`-fast` twin).
- Therefore the row is `catalogOnly: true`, exactly like `anthropic/claude-fable-5.1` (`src/shared/types.ts:4372`), and its effort entry is `["max","xhigh","high","medium","low","auto"]` (Gateway values + fx's always-present `auto`), exactly like the Fable 5.1 row at `:3787`. The driver validates effort at runtime; a wrong curated set is a picker-hint problem, never a failed run.

### 1.7 Other harnesses

- **GitHub Copilot:** npm `@github/copilot` latest **1.0.108** (published 2026-11-09). Its changelog's only Fable entries are `claude-fable-5.1` (1.0.83) and `Claude Fable 5`; no Fable 5.2. Its darwin-arm64 binary contains no `claude-fable*` ids. The harness's model list is server-driven, so this is "not supported now", not "impossible forever" — a follow-up belongs in the plan's ledger.
- **Antigravity:** Homebrew cask `antigravity-cli` 1.5.1; the downloaded 1.5.1 arm64 binary contains `claude-opus-5-5-{high,medium,max,low}`, `claude-sonnet-5-5-{high,medium,max,low}`, and Gemini ids, but **zero** `claude-fable*` ids. No action.
- **OpenCode:** v2.1.3; `opencode models` already lists `opencode/claude-fable-5-2` under the OpenCode Zen provider. OpenCode is `CATALOG_SCOPED_KINDS`, with only the pinned "OpenCode default" curated row; discovered models append automatically. No curating or migration.
- **Codex / Gemini:** no Anthropic model catalogs; not applicable.
- **Pipeline (`AGENTS_CONFIG.yml` / `/implement`):** `type: claude` models are aliases (`opus | sonnet | haiku | fable`), not version pins. The `fable` alias now resolves to 5.2 inside the CLI, so the pipeline automatically uses 5.2 when configured with `fable`; no code or config change.

### 1.8 Existing data (read-only, 2026-11-09)

- Prod DB (`~/.agetor/agetor.sqlite`, opened read-only): **227 tasks** on `fable-5`, **84 tasks** on `fable-5.1`; **zero** tasks/profiles on any `claude-fable-5-1-*` or `claude-fable-5-2-*` Cursor variant; `lastModel:cursor` is `grok-4.7`.
- Dev DB (`~/.agetor-dev/agetor.sqlite`): no Fable rows at all.
- Implication: there is no Claude Code data migration. Existing Fable 5/5.1 tasks keep their explicitly stored ids and still launch those models. The Cursor migration is for future/other users and is data-clean on this machine today (which makes it cheap but still worth including for correctness).

### 1.9 Runtime and trust shape

- Agetor is a local desktop app (Bun core + webview) over a localhost, token-authenticated HTTP API; one core per data dir, SQLite storage. This change adds no new process, route, network peer or trust boundary — model rows are static local config.
- The only account-scoped gate is fx's `catalogOnly`, which already fails closed on discovery-empty/logged-out harnesses (`mergeModelOptions`). No secrets or external input are involved in adding a row.

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does Claude Code 2.1.321 ship Fable 5.2 and make it the Fable default? | **Yes** | `claude --version` → `2.1.321`; binary strings → `FABLE_ID:"claude-fable-5-2"`, `FABLE_NAME:"Claude Fable 5.2"`, `fable:{default:"claude-fable-5-2",…}`, `latest_per_family.fable:"claude-fable-5-2"` | claude 2.1.321 | session scratchpad: `claude.strings` |
| What are Fable 5.2's price/context/effort? | **$8/$40 per MTok, $0.20 cache read; 1M/128K; low→max; default medium** | Changelog 2.1.321 first entry; binary metadata `pricing:"tier_8_40_cache_read_0_20"`, `context.window:1e6`, `max_output_tokens:128000`, capabilities `effort,max_effort,xhigh_effort`, `default_effort:"medium"` | claude 2.1.321 | Scratchpad strings + [Claude Code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) |
| Does Cursor offer Fable 5.2, and in which variants? | **Yes — five plain effort ids; no thinking/fast** | `cursor-agent models` → 279 rows; `claude-fable-5-2-{low,medium,high,xhigh,max}`; labels contain `1M`; zero `-thinking-`/`-fast` Fable 5.2 ids | cursor-agent 2026.10.22-27dcf5f | Scratchpad `cursor-models.txt` |
| Does fx offer Fable 5.2? | **Yes in the public/unauth catalog; absent from the owner's signed-in catalog → `catalogOnly`** | `HOME=<empty> fx models --json` → 266 ids incl. 5.2; real `fx models --json` → 138 ids, zero `anthropic/*`; public Gateway → 504 entries, `anthropic/claude-fable-5.2` with low→max | fx 0.0.15 | Scratchpad `fx-public-models.json` / `fx-empty-home` |
| Does Copilot offer Fable 5.2 today? | **No evidence** | npm latest 1.0.108; changelog only Fable 5.1 (1.0.83) and Fable 5; darwin-arm64 binary has no `claude-fable*` ids | @github/copilot 1.0.108 | Scratchpad `copilot-pkg/changelog.md` |
| Does Antigravity offer Fable 5.2? | **No** | 1.5.1 arm64 binary strings: Opus/Sonnet 5.5 and Gemini ids, zero `claude-fable*` | antigravity-cli 1.5.1 | Scratchpad `spikes/antigravity` |
| Does OpenCode already expose it? | **Yes, dynamically** | `opencode models` → `opencode/claude-fable-5-2` | opencode v2.1.3 | (command output) |
| Do any existing tests pin `fable-5.2`? | **No** | `grep -rn "fable-5.2" src e2e docs` → zero; the only Fable 5.1 picker assertion is `agents.test.ts:386` | repo @ `897b70af` | (grep) |
| Is the targeted test baseline green? | **Yes** | `bun test src/shared/types.test.ts` → 70 pass; `...effort-support.test.ts` → 103 pass; `...agents.test.ts` → 279 pass | bun 1.3.10 | (command output) |
| Is there stored Cursor Fable 5.2 variant data to migrate? | **None today on this machine** | read-only sqlite: `tasks`/`agent_profiles` with `claude-fable-5-2%` or `claude-fable-5-1%` → 0 rows; `lastModel:cursor` → `grok-4.7` | prod + dev DBs | (sqlite output) |
| Are prior Fable tasks still valid? | **Yes** | 227 tasks on `fable-5`, 84 on `fable-5.1`; those ids remain valid CLI models | prod DB + changelog | (sqlite output) |

No spikes were needed: each load-bearing claim was settled by a live binary/catalog probe or by reading the repo's own tests and precedent migrations.

## 3. What we're assuming

- **A1 — Cursor max mode works for Fable 5.2.** Every 5.2 row is labelled "1M", Fable 5.1's spec has `supportsMaxMode: true`, and the max-mode bracket is generic. No live `claude-fable-5-2[context=1m,effort=…]` spawn probe was run (would spend a Cursor turn). If rejected, the fix is one flag/test assertion, same as Sonnet 5.5's inverse case.
- **A2 — Claude 2.1.321's bare `/model` Fable row resolves to Fable 5.2.** Proven indirectly by the alias table (`fable.default = claude-fable-5-2`), `latest_per_family`, and the changelog. It was not smoked through the live picker. If the row still resolves to 5.1, the orchestrator's `Set model to …` stdout sync self-corrects the row and breadcrumbs; no corruption, only a degraded mid-session mirror until the user re-picks.
- **A3 — fx's effort set is `["max","xhigh","high","medium","low","auto"]`.** Taken from the public Gateway `reasoning_options` (low→max) plus fx's always-present `auto`; not ACP-probed. The driver validates at runtime and degrades to a status breadcrumb, never a failed turn.
- **A4 — Copilot will add Fable 5.2 in a later CLI release.** Today's 1.0.108 has no mention; if GitHub ships it silently server-side before a changelog entry, agetor will still discover it only if it is in the installed CLI's model list (Copilot is not catalog-scoped), so a follow-up may be needed then.
- **A5 — No claude-code `MODEL_MIN_CLI_VERSION` floor.** The Fable 5.1/Opus 5.5/Sonnet 5.5 additions deliberately added none; an older CLI fails at spawn for an unknown id, which is the signal. Adding a 2.1.321 floor would touch the exact-keys test (`effort-support.test.ts:223-225`) and is not required for a new row.
- **A6 — The default stays Opus 5.5.** Fable 5.2 is exactly 2× Opus 5.5 usage; the house rule keeps the default on the most-capable non-premium tier. The owner's 227 Fable 5 tasks show they do choose premium models deliberately, but that does not imply a default flip.
- **A7 — Mythos 5.2 is out of scope unless the owner asks.** The task names Fable 5.2 only. If added, it is Claude Code-only (no Cursor/fx/Copilot/Antigravity catalog), gets `mythos-5.2` / `claude-mythos-5-2`, full effort, `[]` mode deny, and `null` picker family (claude has no Mythos row).
- **A8 — The "2x the usage of Opus" copy remains acceptable for Fable 5.2.** $8/$40 is exactly 2× Opus 5.5. Fable 5.1 is now 2.5× Opus 5.5 ($10/$50), but its existing "2x" copy is a prior-release hint; refreshing it is optional copy work, not a correctness issue.
- **A9 — The Cursor migration is additive and safe even with zero current rows.** It normalizes future/other users' stored variant ids into the shape `cursorModelArg` re-composes; one-way, idempotent, kind-joined.
- **A10 — Plan/org access is enforced by the harness, not by agetor.** Claude Code may grey out or refuse Fable 5.2 on plans/orgs without Fable access; agetor still shows the curated row and lets the CLI report the access error, exactly as it does for Fable 5.1. Cursor/fx gate through their own catalogs (fx `catalogOnly`, Cursor account availability). No new pre-flight is proposed.

## 4. What we must ask the owner

1. **Harness scope.** Recommended: **Claude Code + Cursor + fx (`catalogOnly`)**. Claude Code is required; Cursor has five live variants; fx has the model in its public/unauth catalog but not in a standard signed-in catalog, so its row is invisible there unless the account has Anthropic access. Do you want the invisible fx row for parity with Fable 5.1/Opus 5.5/Sonnet 5.5/Haiku 5.5, or Claude Code + Cursor only?
2. **Mythos 5.2.** The CLI ships it as Fable 5.2's twin, same price/context/effort, org-gated. The task says "Fable 5.2" only. Add `mythos-5.2` alongside (Claude Code only), or leave Mythos 5.1 as the latest Mythos row? Recommendation: add it only if you want family parity; otherwise leave it out and record the deferral.
3. **Default model.** Keep `opus-5.5` (recommendation), or make Fable 5.2 the new Claude Code default? Fable 5.2 is exactly 2× Opus 5.5 usage. A default flip also ripples through `DEFAULT_MODEL`, the effort fallback test, `e2e/agent-profiles-launch.spec.ts`, README:78 and the default comments.
4. **Cursor migration.** Include `084_normalize_cursor_fable_5_2.sql` (five plain variants → base + effort + `speed='off'`, kind-joined, plus `lastModel:cursor`)? Recommendation: **yes**, per the 055/056/060/062/064/076 convention, even though this machine has no stored rows. Also: should it backfill the **Fable 5.1 plain variants** that the 5.1 spec covered without a migration (a pre-existing gap; thinking variants must stay untouched)?
5. **Picker order and hint copy.** Recommended: keep the existing family grouping — Mythos rows first (5.1, 5), then Fable 5.2 / 5.1 / 5, then Opus — because the list is family-grouped, not globally newest-first. Alternatively put Fable 5.2 at the very top as the newest widely released model. Also confirm the prior-release wording ("Prior Fable release" for 5.1, "Earlier Fable release" for 5) and whether to keep the historical "2x" hints as-is.
6. **Copilot follow-up.** Confirm it is out of scope now (1.0.108 has no Fable 5.2) and should be picked up when Copilot's changelog names it; the plan's completeness ledger will record it.

The facts above answer "is it available?", "what ID?", "what efforts?", "what price?", "what does the existing code do?" — the owner only needs to decide scope/trade-offs.

## 5. Completeness inventory

Line numbers are at `897b70af`.

### Callers and readers of what changes

All are table-driven and need no code change beyond the tables:

- **Pickers:** `src/mainview/components/kanban/NewTaskForm.tsx` (New Task), `RunPanel` task details, `TaskLaunchPickers` (Resolve-Conflicts / Create-from-issue / Clone dialogs, Settings → Agents), all through `mergeModelOptions` (`src/shared/model-options.ts`). CLI `agetor add` / `edit` / `profile add|edit` read `AGENT_OPTIONS`.
- **claude-code paths:** `buildCommand` (`src/bun/agents.ts:622-642`) via `toClaudeModelArg`; `claudeModelPickerFamily` ← `reconcileTaskSession` (`src/bun/orchestrator.ts:3716-3766`); `claudeModelIdFromArg` / `claudeModelIdFromDisplayName` in `src/bun/claude-local-setting.ts`; `applyClaudeLocalSetting` in the orchestrator.
- **Effort/mode:** `supportedEfforts` (`src/shared/types.ts:3980-4000`), `supportedModes` (`:4101-4109`), `defaultEffortFor`/`effortFallbackForModelChange` in the orchestrator, server PATCH validation.
- **Cursor:** `CURSOR_MODEL_SPECS` → `AGENT_OPTIONS.cursor.models` (`types.ts:4187-4192`), `MODEL_EFFORT_SUPPORT.cursor` (`:3699-3704`), `cursorModelArg`/`cursorModelSupportsFast`/`cursorModelSupportsMaxMode`/`cursorModelIdCoveredByCatalog` (`:3433-3474`), `discoverCursor`'s covered-id filter.
- **fx:** `AGENT_OPTIONS.fx.models` / `MODEL_EFFORT_SUPPORT.fx`, `mergeModelOptions` (`CATALOG_SCOPED_KINDS`), `discoverFx` (`src/bun/agent-discovery.ts`), `applyFxEffort` (`src/bun/fx-acp.ts`).
- **Usage:** `src/bun/usage/claude-usage.ts` is model-name-agnostic (scoped meters format `Weekly (<display name>)`); no change.
- **Bundles/profiles:** model ids are stored verbatim; no shape change. Frozen `tasks.agent_profile` / `tasks.pipeline_run` snapshots are deliberately not rewritten.

### Edit sites — claude-code (required)

- `src/shared/types.ts`
  - `AGENT_OPTIONS["claude-code"].models` (`:4135-4152`): add `fable-5.2` at the top of the Fable block; demote `fable-5.1` to a prior-release hint (and `fable-5` to an earlier-release hint if desired). Add `mythos-5.2` above Mythos 5.1 only if §4 Q2 says yes.
  - `MODEL_EFFORT_SUPPORT["claude-code"]` (`:3605-3644`): add `fable-5.2` → `["max","xhigh","high","medium","low"]`; update the header comment (`:3597-3604`).
  - `MODEL_MODE_DENY["claude-code"]` (`:4072-4088`): add `fable-5.2` → `[]`.
  - `EFFORT_OPTIONS` xhigh hint (`:3566`): add Fable 5.2.
  - `DEFAULT_MODEL` comment (`:2822-2828`): add 5.2 to the premium-tier sentence (comment only).
- `src/bun/agents.ts`
  - `CLAUDE_MODEL_FLAG` (`:226-241`): add `"fable-5.2": "claude-fable-5-2"`; optionally `"mythos-5.2"`.
  - `claudeModelPickerFamily` (`:313-326`): `"fable-5.2"` → `"Fable"`; remove the `"fable-5.1"` case (it falls to `null`). Update the doc comment (`:275-312`) with CLI 2.1.321 evidence and the supersession.
- `src/bun/orchestrator.ts` (`:3720-3729`): update the superseded-id comment to name `fable-5.1` (and, if added, `mythos-5.2`).
- `src/mainview/components/kanban/NewTaskForm.tsx` (`:1120-1136`): comment only; the family check already works.
- `src/bun/claude-local-setting.ts`: no code change; add tests only.

### Edit sites — Cursor (recommended)

- `src/shared/types.ts`
  - `CURSOR_MODEL_SPECS`: add `"claude-fable-5-2"` immediately before `"claude-fable-5-1"` (`:3134-3145`) with label "Fable 5.2", hint "Anthropic Fable 5.2 via Cursor.", `supportsMaxMode: true`, five plain effort ids, **no** `fastEfforts`; comment the 2026-11-09 measurement (279 rows, no thinking/fast variants, `1M` labels).
- `src/bun/migrations/086_normalize_cursor_fable_5_2.sql` (new; authored as 084, renumbered on merge with main's harness-stacks migrations 084/085)
  - Five UPDATEs (tasks, agent_profiles, preferences), exact IN list `claude-fable-5-2-{max,xhigh,high,medium,low}`, `effort = …`, `speed = 'off'`, `model = 'claude-fable-5-2'`, kind-joined via `harnesses.kind = 'cursor'`; `updated_at` untouched; frozen snapshots untouched; idempotent. If §4 Q4 includes the 5.1 backfill, add a separate block for the five plain 5.1 variants and leave `-thinking-*` alone.
  - `src/bun/migrations/index.ts:113/214` — import + register last.
- `src/bun/migrate.test.ts` — new 084 test (clone 060's shape); update the last-migration pin at `:2015`, `:2028-2041`, `:2090-2097`.

### Edit sites — fx (recommended)

- `src/shared/types.ts`
  - `AGENT_OPTIONS.fx.models` (`:4347-4390`): add `anthropic/claude-fable-5.2`, label "Claude Fable 5.2", generic premium hint, `catalogOnly: true`, above the Fable 5.1 row (`:4372`).
  - `MODEL_EFFORT_SUPPORT.fx` (`:3767-3846`): add `["max","xhigh","high","medium","low","auto"]` above the 5.1 row (`:3787`), plus a dated note (public Gateway `reasoning_options`, not ACP-probed).
  - History comments/counts: `AgentOption.catalogOnly` doc (`:2770-2776`; 26→27 of 42→43), `AGENT_OPTIONS.fx.models` history (`:4320-4346`), `efforts` comment (`:4396-4402`; 40/42→41/43).
- `src/bun/agent-discovery.ts:556-566`, `src/bun/fx-acp.ts:512-520`, `src/bun/orchestrator.ts:8579-8586` — add 5.2 to the "postdate this measurement" lists / count prose.
- `docs/architecture/harness-fx.md:72-79,123-129` — effort-group ordinal/count and curated counts.
- `e2e/fx-models.spec.ts:60-104` — add `"Claude Fable 5.2"` to `EXCLUDED_FX_OPTION_LABELS`; re-count the "eighteen of the twenty-six" prose from the file. The existing positive Fable 5.1 test (`:433-475`) can stay; optionally add a parallel 5.2 positive test behind the same stub.

### Tests that pin the catalogs

- `src/bun/agents.test.ts`: add `buildCommand` case for `fable-5.2` → `--model claude-fable-5-2` (mirror `:323-341`); move `claudeModelPickerFamily("fable-5.1")` from the current-release test (`:386`) to the null test (`:390-409`), add `fable-5.2` → `"Fable"`, and add a `mythos-5.2` case only if added.
- `src/bun/effort-support.test.ts`: add `claude fable-5.2 supports xhigh + max` (mirror `:115-125`); cursor tests: ladder `["max","xhigh","high","medium","low"]`, `cursorModelArg("claude-fable-5-2","xhigh",false)` → `claude-fable-5-2-xhigh`, fast never composes, max-mode bracket `claude-fable-5-2[context=1m,effort=xhigh]`, `cursorModelIdCoveredByCatalog("claude-fable-5-2-high")` true (mirror `:670-686`).
- `src/bun/claude-local-setting.test.ts`: `claudeModelIdFromArg("claude-fable-5-2")` → `fable-5.2`; display-name cases for `"Fable 5.2"`, `"Fable 5.2 (1M context)"`, and no conflation with `"Fable 5.1"` / `"Fable 5"`; `parseClaudeLocalSetting` `Set model to Fable 5.2 …` / `Kept model as Fable 5.2` (mirror `:42-43,177-220,344-378`).
- `src/bun/orchestrator-paste-withheld.test.ts:1202-1271` — the "target not offered" fixture currently sets `after.model = "fable-5.1"`; it must move to `"fable-5.2"` because 5.1 becomes `null` and would short-circuit before the picker (the Sonnet 5.5 plan records this exact gotcha). Update the expected status string; cosmetic pane descriptions ("Fable 5" → "Fable 5.2") optional. Optionally add a dedicated "superseded fable-5.1 never drives the picker" test, mirroring Opus 5.5's.
- `src/shared/types.test.ts` (only if fx row added): `FX_EFFORT_MODELS["anthropic/claude-fable-5.2"]`, counts 40→41 / 42→43, `expectedCatalogOnly` + size 26→27, and the "twenty-six" test names/comments (`:186-253,357-409,447`).
- `e2e/fx-models.spec.ts:366-400` claude picker exact-list assertion self-derives from `AGENT_OPTIONS`, so it automatically includes the new row; run it. `e2e/fixtures.ts:285-306` (Copilot stub) is untouched.
- No `types.test.ts` copilot changes; no `MODEL_MIN_CLI_VERSION` changes.

### Docs / config / examples

- `docs/architecture/harness-claude-code.md:43-44` — add `fable-5.1` to the superseded list.
- `docs/architecture/harness-fx.md` — counts/ordinals if the fx row is added.
- `docs/architecture/harness-copilot.md:25,69` — no change (no 5.2); mention as a follow-up in the plan ledger.
- `README.md:78` — only if the default changes (recommendation: no).
- `CLAUDE.md` — currently contains no Fable-specific text (the claude bullet moved to `docs/architecture/harness-claude-code.md`), so no edit unless the default/harness table changes.
- Add the new plan doc under `docs/plans/` during planning; do not edit historical plans.

### Existing data a migration would have to backfill

- **Claude Code:** none. `task.model` is a free string; 227 `fable-5` and 84 `fable-5.1` tasks stay valid. No default backfill.
- **Cursor:** `tasks` / `agent_profiles` rows on `claude-fable-5-2-{low,medium,high,xhigh,max}` and `preferences.lastModel:cursor` on those ids. Measured volumes today: **0** in dev and prod; the migration is still recommended for other users/future rows.
- **fx:** none; adding a row is additive.

### What the change would orphan

- Nothing. Old Fable/Mythos rows stay. `fable-5.1` keeps launching correctly; only its live-session picker mirror becomes a next-run breadcrumb. `CURSOR_MODEL_SPECS["claude-fable-5-1"]` stays; only new 5.2 variants become covered.

## 6. Runnability

- **Install first:** this worktree has **no `node_modules`**. Run `bun install` before `bun run typecheck` or any e2e run. The pure/table tests already run without it (`bun test src/shared/types.test.ts`, etc.).
- **App:** `bun run dev:hmr` (webview + backend) with `AGETOR_DATA_DIR="$HOME/.agetor-dev"` and `AGETOR_API_PORT=4318`; `bun run dev` needs a prior `bun run build`. Never point a smoke run at the prod `~/.agetor` DB.
- **Typecheck:** `bun run typecheck`.
- **Targeted unit/integration tests:**
  - `bun test src/shared/types.test.ts src/bun/agents.test.ts src/bun/effort-support.test.ts src/bun/claude-local-setting.test.ts src/bun/orchestrator-paste-withheld.test.ts`
  - add `src/bun/migrate.test.ts` if the Cursor migration lands.
  - Baseline observed: 70 / 103 / 279 pass for types / effort / agents respectively (bun 1.3.10, no `node_modules` needed for those three files).
- **Full suite:** `bun test`; check load first (the repository has known flaky tmux-socket tests at high load).
- **E2E:** `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` (run one Playwright invocation at a time; it boots its own headless backend and uses the fx stub). The Claude picker assertion self-derives; if the fx row is added, the negative-label list needs updating. No new harness/stub is required.
- **Live probes used here (re-runnable):** `claude --version`; `strings` on the installed claude binary; `cursor-agent models`; `fx models --json` (signed-in and `HOME=<empty>`); `curl https://ai-gateway.vercel.sh/v1/models`; `npm view @github/copilot version` + its changelog; `brew info --cask antigravity-cli` + its binary strings; `opencode models`; read-only sqlite counts.

## 7. Risks and blast radius

- **Wrong argv if `CLAUDE_MODEL_FLAG` is missed.** Unknown ids pass through verbatim, so `--model fable-5.2` would be sent instead of `claude-fable-5-2`. This is the single most important edit and must have a `buildCommand` test.
- **Wrong picker family if 5.1 is not demoted.** If `fable-5.1` still maps to `"Fable"` after 5.2 takes the row, a mid-session dropdown change to 5.1 would drive the picker to 5.2. The existing test currently *asserts* the wrong future behavior (`agents.test.ts:386`), so the suite will not catch this unless the test is moved; the plan must do it.
- **Cursor spec hides discovered rows.** A stored `claude-fable-5-2-<effort>` would render unlisted with a collapsed effort picker after the spec lands. Migration 084 restores the base+effort shape; without it, runs still launch verbatim but the UI is degraded.
- **Count drift.** Adding the fx row moves 26→27 `catalogOnly`, 42→43 curated, 40→41 effort-advertising across `types.ts` comments, `types.test.ts`, `orchestrator.ts`, `agent-discovery.ts`, `fx-acp.ts`, `docs/architecture/harness-fx.md` and `e2e/fx-models.spec.ts`. Re-count from the file, never copy an old number.
- **Do not add rows for unsupported harnesses.** Copilot 1.0.108 has no Fable 5.2, and Antigravity has never carried Fable; adding either would produce a row that fails at spawn. OpenCode needs no curated row.
- **Default flip is a separate product decision.** Keeping `opus-5.5` avoids a silent 2× usage change for every new task. If the owner flips it, the default anchors listed in §4 Q3 must be updated in the same wave.
- **Docs/comments drift.** `docs/architecture/harness-claude-code.md:44`, `src/bun/agents.ts:275-312`, `src/bun/orchestrator.ts:3720-3729`, `NewTaskForm.tsx:1120`, `DEFAULT_MODEL` comment and the fx counts all describe the current state and should move with the code.
- **Rollback:** the new rows/spec/flag are additive; revert the commit(s). Migration 084 is one-way like 055/056/060/062/064/076 — a rollback is a new migration, not a down-migration. No existing Claude data is mutated.

## 8. Bottom line

The model is real, shipped today in Claude Code 2.1.321 (default Fable, $8/$40, 1M, low→max, `fable` alias → 5.2), and is live in Cursor (five plain effort ids) and the fx Gateway (public/unauth; `catalogOnly` for standard accounts). Copilot has not shipped it; Antigravity does not carry Fable; OpenCode already discovers it. The change is the well-trodden Fable 5.1 / Sonnet 5.5 / Haiku 5.5 shape: one curated claude row + flag + effort/mode maps + picker-family supersession, one Cursor spec + migration, one fx `catalogOnly` row + effort entry, plus the tests/docs those touch. The two decisions that materially change the plan are **harness scope (fx?)** and **Mythos 5.2 parity**; the default should stay Opus 5.5 unless the owner says otherwise.
