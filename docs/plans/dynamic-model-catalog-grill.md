# Grill — dynamic model & effort catalog per harness

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | Pipeline task text "Alamo Pipeline (No Video)" (agetor task prompt, outside the repo) + investigation brief `docs/plans/dynamic-model-catalog-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 3 rounds (round 2: one re-ask + push-back on overrides and notes; round 3: two push-backs) |
| Answers | `docs/plans/dynamic-model-catalog-grill/round-1/answers.json`, `round-2/answers.json`, `round-3/answers.json` |
| Flags | none |
| Spec | outside the repo (the pipeline task prompt). The goal is: *"Currently we're kinda manually adding support for models in the list for most of the harnesses. What I want is a dynamic way for picking the models and their efforts automatically from the harnesses, so we don't have to come release by release when a new model drops. We still have to support older version, so it must be flexible too."* Copy it into `docs/plans/dynamic-model-catalog.md` with the plan. |

No one-way doors are awaiting a human. The two one-way-door questions were answered directly by the owner: `claude-id-scheme` (r1) and `claude-fast-mechanism` (r2).

## Decisions

Sources cite `rN/answers.json#<question-id>`. "acc." means the owner accepted my recommendation. "override" means the owner picked differently, and the answer is binding.

### Scope

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Scope | Which harnesses get new or extended discovery? | **Claude Code** (new `initialize` probe), **Cursor** (structured base + effort + fast), **Gemini** (`gemini models -o json` on ≥ 0.67), **Codex** (also read `isDefault`/`defaultReasoningEffort`, plus speed tiers, see #13), **Copilot** (new ACP probe for models + efforts, see #18), **Antigravity** (no new source; the curated-table policy only). fx and opencode are unchanged. | owner, override (r1#harness-scope; I had recommended leaving copilot ACP out) |
| 2 | Scope | The refresh button | Owner note: *"We have a refresh icon button already, right? to refetch the options"*. **Yes**: `NewTaskForm.tsx:1050` `Refresh model list` → `POST /agent-models` re-runs every probe. New probes join that path; no new UI. A refresh also overwrites the persisted catalog (#16). | owner note + evidence |
| 3 | Curated tables | Fate of `AGENT_OPTIONS`, `MODEL_EFFORT_SUPPORT`, `CLAUDE_MODEL_FLAG`, `CURSOR_MODEL_SPECS`, … | **Keep them, frozen.** They are the fallback for old, offline, logged-out or failed-probe CLIs, plus an optional label/hint overlay. **Policy: a new model never needs a new row**; add a row only to override a label or hint (pricing, "2x usage"). | owner, acc. (r1#curated-fate) |

### Claude Code

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 4 | Ids (one-way door) | How do CLI ids map onto agetor ids? | **Keep friendly ids and derive them by rule.** Strip `claude-`, strip a trailing `-YYYYMMDD`, and turn the last `-N-M` into `-N.M` (`claude-opus-5-5` → `opus-5.5`, `claude-haiku-4-5-20251001` → `haiku-4.5`, `claude-opus-6` → `opus-6`). Aliases resolve via `resolvedModel`. The CLI's `default` row is dropped. The reverse rule builds `--model`, so `CLAUDE_MODEL_FLAG` shrinks to an exception list. No stored-data migration. | owner, acc. (r1#claude-id-scheme) |
| 5 | Display names | Owner note on #4: *"Let's also beautify the names, like, opus-5.5 can become Opus 5.5."* Where do raw ids stop showing? | **Everywhere a model is shown to a person.** Picker rows without a label, unlisted rows, the task card (`TaskCard.tsx:331` prints `task.model` raw today), the run panel, stack badges, and CLI/TUI output (`agetor show`, lists). Show the catalog label when there is one, else a prettified id (`opus-5.5` → `Opus 5.5`, `gpt-6.1-sol` → `GPT-6.1 Sol`). Use one shared `modelDisplayName(kind, id, catalog)` helper in `src/shared`. Inputs still accept ids; stored ids don't change. | owner (r1 note) → owner, acc. (r2#pretty-names) |
| 6 | Alias rows | Auto-tracking "Opus (latest)" rows? | **No alias rows.** A task keeps the model it was created with. New versions appear through discovery. | owner, acc. (r1#claude-alias-rows) |
| 7 | Scoping | Hide curated rows the CLI doesn't list (Mythos)? | **Unscoped, one probe per kind.** Curated rows always show, so Mythos stays. Discovered models are added. Claude does **not** join `CATALOG_SCOPED_KINDS` or `PER_HARNESS_KINDS`. | owner, override (r1#claude-scoping; I had recommended per-harness probing) |
| 8 | Kind probe account | Which account does the single probe use? | The built-in claude harness's config (default `~/.claude`, or its `CLAUDE_CONFIG_DIR` if set). Its models and efforts apply to every claude harness, stack accounts included. If that harness is logged out, the result is distrusted (merge rule 7) and the curated tables apply. | owner, acc. (r2#claude-kind-probe) |
| 9 | Probe isolation | How is the probe isolated? | `coreSpawn` with `--strict-mcp-config` (no MCP servers), `disableAllHooks`, `--no-session-persistence`, an empty cwd under the data dir, the harness's `CLAUDE_CONFIG_DIR`, and a 10 s timeout. Parse only `models[]`. **Never log or store the raw response** (it carries the account email and org). If build-time checks show MCP servers or hooks still start, claude stays curated and the finding is reported back. | owner, acc. (r1#claude-probe-isolation) |
| 10 | Pre-existing bug | Curated Opus 4.6 offers `xhigh` | **Fix it in this change**: drop `xhigh` from `MODEL_EFFORT_SUPPORT["claude-code"]["opus-4.6"]`. A stored `xhigh` on existing tasks is kept (`retainableEfforts`) and never PATCHed away. | owner, acc. (r1#opus-46-xhigh) |

### Defaults, efforts, ordering, floors, persistence

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 11 | Defaults | Who picks the default model and effort? | **The owner pick stays, with the CLI's default as the fallback.** `DEFAULT_MODEL`/`DEFAULT_EFFORT` win. The CLI-reported default (codex `isDefault`, claude `default`'s `resolvedModel`) is used only when the owner pick is missing from a non-empty discovered catalog. The CLI's per-model default effort (codex `defaultReasoningEffort`) applies when the owner's effort isn't in that model's ladder. | owner, acc. (r1#defaults) |
| 12 | Unknown efforts | A CLI reports an effort level agetor doesn't know | **Synthesize a row and pass it through.** Use the CLI's label if it gives one, else the id title-cased; sort it into the ladder where known. At spawn the value must be in that model's discovered set **and** match `^[a-z0-9_-]{1,32}$`. This replaces the closed filtering in `supportedEfforts` (`types.ts:4640`) and `CLAUDE_EFFORT_VALUES` (`agents.ts:372`) for discovered levels. | owner, acc. (r1#unknown-efforts) |
| 13 | Ordering + labels | Where do discovered models land in the picker? | **The CLI's order wins; curated-only rows follow.** With non-empty discovery: discovered rows in CLI order, each carrying the curated label/hint if one exists, else the CLI display name (and its description as hint). Curated rows the CLI didn't list (e.g. Mythos) come after, in curated order. With empty discovery: today's curated order. Cursor labels are sanitized (zero-width spaces). | owner, acc. (r1#order-labels) |
| 14 | CLI floors | Retire `MODEL_MIN_CLI_VERSION`? | **Discovery is checked first; the table becomes a frozen fallback.** Pre-flight and harness-stack failover (`harness-failover.ts:253`) refuse a model missing from a non-empty authoritative catalog (codex, copilot) with an "upgrade the CLI" message. The table is used only when discovery is empty and gets no new rows. | owner, acc. (r1#min-cli-floor) |
| 15 | No-effort fallback | A discovered model with no reported efforts and no curated row | Today's fallback stays: the default model's ladder for claude < 2.1.49 and copilot; no effort picker for gemini, antigravity and unparsed cursor rows. Haiku 4.5's curated "no effort" stays authoritative. | owner, acc. (r1#no-effort-fallback) |
| 16 | Persistence | Should the last discovered catalog survive a restart? | **Persist it in the `preferences` table, no migration.** One key per kind or harness (`modelCatalog:<id>`) holds the parsed catalog, the CLI version it came from and a timestamp. It is used until a fresh probe replaces it and dropped when the CLI version changes. Only parsed models are stored, never claude's account/email fields. | owner, acc. (r1#persist-catalog) |
| 17 | Cadence | When do the new probes run? | The same scheduler and triggers as today: boot, harness status change, harness CRUD, manual refresh, and the 15-minute sweep. No new route or SSE stream; reuse `agent_models_changed`. | owner, acc. (r1#probe-cadence) |

### Cursor, copilot, gemini

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 18 | Cursor source | Where do families, efforts and fast variants come from? | **Parse the flat `cursor-agent models` list into base + effort + fast.** Known effort/fast suffixes are peeled off; anything that doesn't parse stays a plain row with no effort picker. `CURSOR_MODEL_SPECS` stays as a frozen overlay and wins where both exist. Normalization moves to read time: **no more cursor id-normalization migrations.** The ACP parameterized probe is rejected (52 s, and it writes `~/.cursor/cli-config.json`). | owner, acc. (r1#cursor-strategy) |
| 19 | Cursor driver | Flat ids or the bracket form? | The driver keeps passing flat variant ids (`grok-4.7-high-fast`), not `base[effort=…,fast=…]`. | owner, acc. (r1#cursor-param-driver) |
| 20 | Cursor side effect | Do agetor's cursor runs change the user's interactive default? | Check once during the build (diff `~/.cursor/cli-config.json` before and after a run). If they do, record a separate ticket. This change only guarantees that the new discovery never writes it. | owner, acc. (r1#cursor-config-side-effect) |
| 21 | Verification | Copilot, gemini and agy aren't installed here. How do we verify them? | **Build from docs + stub fixtures only.** No live run against copilot or gemini in this change. | owner, override (r2#live-verify; I had recommended installing them) |
| 22 | Copilot ACP | With stub-only verification, what happens to the copilot ACP probe? | **Build it from the ACP spec and ship it on.** Any failure falls back to today's `help config` probe. This **supersedes** the round-2 guard confirm (r2#copilot-acp-guard, "not shipped if it costs a request / writes config / lists no efforts"), because those checks can't run without copilot. What still holds at runtime: no models, or a malformed response, falls back to `help config`. | owner, override (r3#copilot-acp-blind; I had recommended shipping it off) |
| 23 | Antigravity / copilot ids | Probes otherwise | Antigravity keeps `agy models`. Copilot's `help config` stays as the fallback probe. The curated-table policy (#3) applies to both. | owner, acc. (r1#copilot-unchanged, read together with #1 and #22) |

### Speed (claude, codex)

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 24 | Scope | Speed tiers reported by claude (`supportsFastMode`) and codex (`fast` / `serviceTiers`) | **In this change.** Claude and codex get the per-task Speed picker that cursor and fx have (`src/shared/speed.ts`), driven by the discovered per-model flags. | owner, override (r1#speed-tiers; I had recommended a separate ticket) |
| 25 | Default | Default Speed for a new claude or codex task | **Remember the last pick per kind** (`lastSpeed:<kind>`, which already exists for cursor/fx). Owner note: *"make sure we disable it if the new task chooses a model/harness/etc that doesnt support fast mode or ultrafast mode, etc., the same for efforts"*. So a remembered Fast (or Ultrafast) is disabled when the selected model or harness doesn't support it, and a remembered effort falls back to the model's default when unsupported. | owner, override + note (r2#speed-default) |
| 26 | Memory after a fallback | Remembered Fast and a model that can't do Fast: what happens to the memory? | **The fallback overwrites the memory with Standard** (today's write-on-submit behavior, `NewTaskForm.tsx:689`). Efforts behave the same way. | owner, override (r3#speed-remember-unsupported) |
| 27 | Claude mechanism (one-way door) | How claude fast mode is switched on | **Per-run switch only** (a CLI flag, or `--settings` JSON passed only to agetor's spawn). If none exists, **claude Speed is cut** from this change and the finding is reported. Never `/fast` into the session, never a write to `~/.claude/settings.json`. Codex passes the tier through its config flag (exact form verified at build time against codex-cli 0.166.0). | owner, acc. (r2#claude-fast-mechanism, r2#speed-notice) |
| 28 | Mid-task change | When a Speed change takes effect | At the **next spawn** (new run or resume), shown as "applies on the next run" in the task editor. | owner, acc. (r2#speed-midtask) |
| 29 | Cost notice | What Fast shows the user | Picking Fast shows the CLI's own description as a hint (codex: "2x speed, increased usage"; claude: its fast-mode text), with the same weight as the existing "Fable bills 2x" notice. | owner, acc. (r2#speed-notice) |

### Surfaces, acceptance, docs

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 30 | Bundles / CLI / TUI | Validation surfaces | Bundle import's "unknown model" warning, `agetor add --model/--effort` validation and the TUI use curated ∪ discovered from the core (`GET /agent-models`). Third-party labels and ids printed by the CLI/TUI go through `escapeFreeText` / `escapeControlChars`. | owner, acc. (r2#bundles-cli; left blank in r1) |
| 31 | Acceptance | What "done" means | A stub claude reporting a new `claude-opus-6` with its own effort ladder makes **Opus 6** appear in the New Task picker, the task editor and `agetor add`, with that ladder and no agetor change. An old or failed probe gives today's curated picker. Tests: a parser unit test per probe with redacted spike fixtures; a cross-kind invariant that no merged picker has two rows for the same CLI model or the same label (the S2 bug); `supportedEfforts` with unknown levels; one Playwright e2e on the stub claude, extending the fx stub-bin seam. | owner, acc. (r1#tests-acceptance) |
| 32 | Docs | Docs to update | `harnesses.md`: the add-a-model / add-a-kind checklist says a new model needs no PR unless it wants a label/hint override. Each touched `harness-<kind>.md`, and CLAUDE.md's "Agent kinds at a glance" probe column. Copy the goal into `docs/plans/dynamic-model-catalog.md`. | owner, acc. (r1#docs) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Claude `initialize` probe, parser, id rule, `CLAUDE_MODEL_FLAG` → exception list, `claudeModelIdFromArg`/`toClaudeModelArg` on the rule | in this change | #4, #9 |
| `claudeModelPickerFamily` hand switch: derive it from claude's alias rows (`opus` → `resolvedModel`) when discovery is present, keep the switch as the fallback | in this change | Would otherwise stay a per-release edit; investigation §2 proven note |
| `claudeModelIdFromDisplayName` (`claude-local-setting.ts:69`) matches labels against `AGENT_OPTIONS` only: also match discovered labels | in this change | Otherwise a `/model` switch to a discovered model isn't recognized |
| `MODEL_MODE_DENY` claude rows (all empty): an unknown model already falls back to `DEFAULT_MODEL`'s row (`types.ts:4766-4767`), which is empty, so no code change is needed. The add-a-model checklist (#32) stops requiring a row | in this change (docs only) | Ends a per-release edit (investigation §5 "would orphan") |
| Gemini ≥ 0.67 probe; older versions keep `[]` | in this change | #1, #21 (stub only) |
| Cursor flat-list parser, read-time normalization, the duplicated "covered by catalog" filter (`NewTaskForm.tsx:440`, `RunPanel.tsx:9086`, `TaskLaunchPickers.tsx:431,470`, `cli/commands/add.ts:846`) consolidated onto the parser | in this change | #18 |
| Codex `isDefault`/`defaultReasoningEffort`/speed tiers read | in this change | #1, #11, #24 |
| Copilot ACP probe, shipped on | in this change | #22 (owner) |
| Speed picker for claude (conditional on a per-run switch) and codex | in this change | #24–#29 |
| `modelDisplayName` used at every display site, CLI/TUI included | in this change | #5 |
| NewTaskForm seed validates `lastModel:<kind>` against curated `AGENT_OPTIONS` only (`NewTaskForm.tsx:361`), so a remembered discovered-only model is dropped on mount: validate against curated ∪ the persisted/discovered catalog | in this change | Found in round 3. Without it, a discovered model doesn't survive as the remembered pick (reviewer would call it unfinished) |
| Persisted catalog in `preferences` | in this change | #16 |
| Unknown effort synthesis + spawn-time charset check (claude env, codex `-c`, copilot `--reasoning-effort`, cursor id) | in this change | #12 |
| `MODEL_MIN_CLI_VERSION` discovery-first check, at pre-flight **and** harness-stack failover | in this change | #14 |
| Opus 4.6 `xhigh` curated fix | in this change | #10 |
| Bundles `knownModels`, `agetor add`, TUI on curated ∪ discovered | in this change | #30 |
| Tests that pin curated content (`*-catalog.test.ts`, `types.test.ts`, `effort-support.test.ts`, …): keep them, since the curated rows are kept frozen. New tests per #31 | in this change | #3, #31 |
| Docs per #32 | in this change | #32 |
| Agetor's per-turn cursor `set_config_option` possibly changing the user's interactive cursor default | out of scope: check once during the build; if confirmed, a separate ticket | owner (r1#cursor-config-side-effect): pre-existing driver behavior, not discovery |
| Claude per-account (per-harness) catalogs | out of scope | owner chose one probe per kind (#7) |
| Claude "latest" alias rows | out of scope | owner (#6) |
| Live verification against copilot / gemini / agy | out of scope for this change | owner (#21): stub-only |
| Migrating stored claude ids | out of scope (not needed) | #4: mapping rule, no migration |
| A new DB table for the catalog | out of scope | #16: `preferences`, no migration |

## Assumptions still open

1. **The copilot ACP probe is harmless on real installs.** Opening an ACP session must cost no premium request and write no copilot config. If that's wrong, every copilot user pays a request or has their config changed on each sweep (every 15 min). The owner accepted this in round 3 by choosing ship-on over ship-off (r3#copilot-acp-blind). The plan should keep the probe's fallback robust and make it a single env-var flip to disable, so it can be pulled quickly.
2. **The copilot ACP response shape follows the ACP spec** (`configOptions` with categories `model`/`thought_level`). If copilot doesn't expose them, the probe returns nothing and `help config` applies. Stub fixtures are written from the spec.
3. **Gemini ≥ 0.67 `models -o json` matches the documented fields** (`modelId, id, name, displayName, description`). If not, gemini stays `[]`.
4. **Claude has a per-run fast-mode switch.** If none exists, claude Speed is cut (#27) and only codex gets Speed in this change.
5. **The claude `initialize` probe starts no MCP servers or hooks** with the isolation in #9. If it does, claude stays curated (#9).
6. **The codex fast tier is passable per run** via a config flag (`-c service_tier=…` or similar; the exact form is verified at build time). If not, codex Speed is cut the same way as claude and reported.
7. **Claude's model list is the same across accounts, except for Mythos-like gating.** The owner chose one kind-level probe (#7), so per-account effort differences, if any, are ignored.
8. **The cursor flat-list grammar stays parseable.** An unrecognized suffix shows as an extra plain row (no effort picker) until the parser learns it. That is acceptable degradation, not a failure.
