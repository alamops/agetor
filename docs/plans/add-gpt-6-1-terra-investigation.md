# Investigation — Add GPT-6.1 Terra (and sweep for other new models)

| Field | Value |
| --- | --- |
| Date | 2026-10-26 |
| Change | Add OpenAI's GPT-6.1 Terra (released 2026-10-26) to every agetor harness catalog that can run it, and find other new models agetor doesn't curate yet. The brief informs which rows, effort sets, CLI floors, hints, counts and (optionally) retirements the plan carries. |
| Agents | none (pipeline step brief: "do not spawn subagents"). Research, git history and spikes were run inline. |
| Flags | none (spikes ran) |
| Branch / base | `feature/add-gpt-6-1-terra` @ `c5cf1a2` |
| Precedent | `docs/plans/add-gpt-6-1-sol.md` (same shape: codex row + floor + fx `catalogOnly` row), commit `35d780e` |

Spike artifacts are in the session scratchpad under `spikes/` (`codex-terra/`, `gateway/`, `fx/`, `cursor/`). That folder is temporary; every number needed later is copied into this brief.

## 1. What we know

### 1.1 GPT-6.1 Terra — the model

- **Identity:** API id `gpt-6.1-terra`, one snapshot. Released 2026-10-26 in ChatGPT Work, Codex and the API. The Codex changelog entry of 2026-10-26 lists Plus, Pro, Business, Enterprise and Edu. ([OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [Codex changelog](https://learn.chatgpt.com/docs/changelog), [9to5Mac](https://9to5mac.com/2026/10/26/openai-upgrades-chatgpt-and-codex-with-new-gpt-6-1-terra-model/)). The openai.com launch post returns 403 to the fetcher, as it did for 6.1 Sol.
- **Positioning:** "A fast, efficient model for visual reasoning, precise computer use, and clear, natural writing." It replaces GPT-5.6 Terra. OpenAI's tier order, cheapest first, is Luna → Terra → Sol → Astra. 9to5Mac notes that Terra was skipped in September's GPT-6 Sol/Luna release. OpenAI gives no retirement date for GPT-5.6 Terra.
- **API facts:**
  - `reasoning.effort`: none, low, medium (the default), high, xhigh, max. `minimal` is not supported.
  - Context: 1.05M; max input 922K; max output 128K.
  - Knowledge cutoff 2026-06-01.
  - Price per MTok: $1 input, $0.05 cached input, $5 output. GPT-5.6 Terra was $2/$12. Above 272K input tokens, input costs 2x and output 1.5x.
  - Input is text and image.
- **No other GPT-6.1 tier was announced.** There is no 6.1 Luna and no 6.1 Astra.

### 1.2 Codex CLI (live, owner's ChatGPT-plan login)

Versions: installed `codex-cli 0.162.1` (`~/.local/bin/codex`, standalone). The app-server daemon is 0.164.0. npm `latest` is 0.164.0, released 2026-10-23, and `alpha` is 0.165.0-alpha.3, released 2026-10-26.

- **Catalog:** `codex app-server` `model/list`, the same JSON-RPC sequence `discoverCodex` uses (`src/bun/agent-discovery.ts:271`):
  - 0.155.1, 0.156.1, 0.157.1 and 0.158.0 list **no `gpt-6.1-*` rows**.
  - 0.159.0, 0.160.0, 0.161.0, 0.162.0 and 0.162.1 (and 0.164.0's `models_cache.json`) list `gpt-6.1-terra` as display "GPT-6.1 Terra", the second row after `gpt-6.1-sol`.
  - Row values: `supportedReasoningEfforts` low/medium/high/xhigh/max/**ultra**, `defaultReasoningEffort: low`, `hidden:false`, `upgrade:null`, description "GPT-6.1 Terra Codex model."
  - Speed: `additional_speed_tiers:["fast"]` and `default_service_tier:"priority"` ("Fast, 1.5x speed").
- **Live `codex exec -m gpt-6.1-terra`** (`"Reply with exactly OK"`, read-only sandbox, `</dev/null`):

  | codex-cli | effort | result |
  | --- | --- | --- |
  | 0.158.0 | low | **400** "The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account." (`model_not_found`), plus "Model metadata for `gpt-6.1-terra` not found" |
  | 0.159.0 | low | **OK** |
  | 0.162.1 | low / **none** / **ultra** | OK / OK / OK |
  | 0.162.1 | minimal | 400 `unsupported_value`: "Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'." |

  So the floor is **0.159.0**, the same `client_version` gate as 6.1 Sol. Unlike 6.1 Sol, Terra **accepts `none`**, so it matches the API page.
- **The rest of the live catalog has drifted from agetor's codex rows:**
  - `gpt-5.5` is absent from `model/list`. A live turn now answers **400** "not supported when using Codex with a ChatGPT account". Its row hint still says "works on ChatGPT plans; codex retires it on 2026-10-14" (`src/shared/types.ts:3638`). That date has passed.
  - `gpt-6-astra-aeon` is still not listed, and a live turn answers 400. Its hint already says "Unverified id" (`:3631`).
  - `gpt-5.6-cyber`, `gpt-5` and `gpt-5-codex` are not listed. Their hints already say API-key / Daybreak only.
  - A hidden `gpt-reserve` ("Fast and affordable agentic coding model", efforts low…max, no ultra) **runs live**. It is undocumented: the only public trace is one [secondhand August report](https://www.80aj.com/2026/08/21/openai-api-gpt-reserve/). `parseCodexModelList` drops `hidden:true` rows (`src/bun/agent-discovery.ts:109`).
  - A hidden `codex-auto-review` row exists. It is codex-internal.
  - `gpt-5.6-terra` is still listed and has no `upgrade` pointer to 6.1 Terra.

### 1.3 Vercel AI Gateway / fx

- **Public catalog:** the Gateway's `/v1/models` (482 entries) has `openai/gpt-6.1-terra` and a `-fast` twin.
  - Released 2026-10-26. Context 1.05M, 128K output, $1/$5 (the `-fast` twin is $2/$10).
  - `reasoning_options`: `[{type:"toggle"},{type:"effort",values:["none","low","medium","high","xhigh","max"]}]`. That is the same shape as `openai/gpt-6-sol`, `openai/gpt-6-luna` and `openai/gpt-5.6-terra`, minus 5.6 Terra's `minimal`.
- **Unauthenticated fx catalog:** `HOME=<empty> fx models --json` (installed **fx 0.0.10**) returns 262 ids, and `openai/gpt-6.1-terra` and its `-fast` twin are present. Every one of the 33 curated fx ids is present.
- **Owner's signed-in catalog:** `fx models --json` with the real HOME (`fx status`: `auth:"fx login"`, refreshable) returns **139 ids**, down from 145 on 2026-10-22.
  - `openai/gpt-6.1-terra` is **absent**. So is every curated `catalogOnly` row.
  - Five **standard** curated rows are absent too: `zai/glm-5.3-flash` (known since 10-22), `openai/gpt-5.4-mini`, `spacexai/grok-4.6`, `minimax/minimax-m3` and `alibaba/qwen3.8-flash`. The curated ∩ discovered merge (`src/shared/model-options.ts`, rule 3) already hides them on that account, so this is copy and data drift, not a runtime fault.
- **Machine note:** the installed fx is 0.0.10 although agetor now drives 0.0.14 features. Discovery on this machine therefore returns ids only, with no `models[].efforts`.

### 1.4 Cursor / Claude Code / Gemini / Antigravity

- **Cursor:** `cursor-agent --list-models` (2026.10.22) shows 270 rows and **zero `gpt-6*` ids**. The newest GPT rows are the 5.6 Sol/Terra/Luna variant families. No curated `CURSOR_MODEL_SPECS` id is missing from the live list.
  - Running `cursorModelIdCoveredByCatalog` over the live list leaves 68 uncovered rows. Most are deliberately uncurated variants: `-thinking` claude variants, non-thinking Opus 5, Haiku 5.5 "No Thinking".
  - Three **new families** are uncovered:
    - `muse-wonder-1.0-{minimal,low,medium,high,xhigh,max}` (Meta; third-party docs give $4/$20, 300K context or 1M in Max Mode)
    - `muse-spark-1.3-{minimal…max}` (Meta; Cursor docs give $1.25/$4.25)
    - `deepseek-v41-flash-1017-{none,low,medium,high,max}` (new since the 10-22 survey)
  - Owner decision D27 of 2026-10-22 (`docs/plans/fx-0.0.14-and-cursor-updates-grill.md:54`) left the `muse-*` families to discovery and said curation is "a separate catalog ticket". This task is arguably that ticket.
- **Claude Code:** CLI 2.1.311. Its binary's model-id strings (`claude-{fable,mythos,opus,sonnet,haiku}-*`) contain nothing newer than what `AGENT_OPTIONS["claude-code"]` already curates (Mythos 5.1, Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5). There is nothing to add.
- **Gemini CLI / Antigravity:** no `gemini`/`agy` binary on this machine. Web search finds no Gemini model after Gemini 4 Argon (GA 2026-10-13, already shipped in `163c2a2`). Gemini 4 Flash/Pro is not announced.

### 1.5 Other models released since the last catalog pass

Taken from the [BenchLM October tracker](https://benchlm.ai/model-updates/releases/october-2026), the [Digital Applied tracker](https://www.digitalapplied.com/blog/ai-model-releases-october-2026-tracker), and the Gateway `released` field. Only models reachable through an agetor harness are listed.

| Model | Released | Reachable via | Signed-in fx? | Notes |
| --- | --- | --- | --- | --- |
| **GPT-6.1 Terra** | 10-26 | codex, fx | no | the target |
| Kimi K3.1 Pro (`moonshotai/kimi-k3.1-pro`, + `-highspeed`) | 10-23 | fx | no | successor to the `catalogOnly` Kimi K3 row; effort low/high/max; $2/$10; web corroboration is thin |
| MiniMax M3.1 Flash (`minimax/minimax-m3.1-flash`) | 10-19 | fx | **yes** | effort low…max; $0.15/$0.60; the curated standard `minimax/minimax-m3` is now absent from the signed-in catalog |
| Inception Mercury 3 (`inception/mercury-3`) | 10-19 | fx | **yes** | effort instant/low/medium/high (`instant` isn't an agetor effort id) |
| DeepSeek V4.1 Flash 1017 (`deepseek/deepseek-v4.1-flash-1017`; cursor `deepseek-v41-flash-1017-*`) | 10-17 | fx, cursor | no | refresh of the fx default's family; effort none/low/high/max |
| Reflection Beam (`reflection/beam`, `-free`) | 10-16 | fx | no | coding model, free beta |
| Meta Muse Spark Open (`meta/muse-spark-open`) | 10-15 | fx | **yes** | effort low…xhigh; $1.25/$4.25 |
| Meta Muse Wonder (`meta/muse-wonder-1.0`; cursor `muse-wonder-1.0-*`) | 10-12 | fx, cursor | no | effort minimal…max; $4/$20 |
| Mistral Large 4 (`mistral/mistral-large-4`) | 10-06 | fx | no | effort none/high |
| Muse Spark 1.3 (cursor `muse-spark-1.3-*`) | 09-03 | cursor | n/a | already deferred by D27 |

Every one of these already appears in its picker through discovery, as a discovered-only row (rules 3–4), wherever the harness's discovery works. Curating a model adds a label, a hint, an effort-table fallback and a picker position. For fx it also adds a `catalogOnly` gate.

### 1.6 How a new codex model reaches the user today

- Codex is not catalog-scoped (`CATALOG_SCOPED_KINDS = {fx}`, `src/shared/types.ts:2583`). A discovered-only id is appended after the curated rows (`mergeModelOptions`).
- **So with codex ≥ 0.159 installed, "GPT-6.1 Terra" already shows in agetor's codex picker, last in the list, with efforts low…ultra.** If discovery is empty (codex missing, probe failed or not ready), it isn't offered at all.
- Discovered efforts win over the curated table in every picker (`supportedEfforts`, `:3467`). The curated row matters only when discovery is empty and in the model-change cascade's union (`effortsAllowed`).
- Pre-flight 1b (`MODEL_MIN_CLI_VERSION`, `:2638`) is table-driven and runs at `startTask`, `spawnCodexTurnNow` and the clone route. It has **no entry for `gpt-6.1-terra`**. A Terra task on codex < 0.159 (reachable via an Agent profile, a bundle import, `agetor add --model gpt-6.1-terra`, or a task created on another machine) would mint a run row and worktree and then fail with the misleading "ChatGPT account" 400.

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Which codex CLI first lists `gpt-6.1-terra`? | **0.159.0** | `python3 -I modellist.py <codex>`: 0.155.1, 0.156.1, 0.157.1, 0.158.0 → no 6.1 rows; 0.159.0, 0.160.0, 0.161.0, 0.162.0, 0.162.1 → `gpt-6.1-terra \| GPT-6.1 Terra \| low…max,ultra \| default low` | npm `@openai/codex@<v>`, owner ChatGPT plan | `spikes/codex-terra/modellist-<v>.txt` |
| Does a live Terra turn need ≥ 0.159.0? | **Yes** | `codex exec -m gpt-6.1-terra -c model_reasoning_effort=low --json … </dev/null`: 0.158.0 → `turn.failed` 400 `model_not_found` "…not supported when using Codex with a ChatGPT account."; 0.159.0 → `agent_message "OK"`, rc 0 | 0.158.0 / 0.159.0 | `exec-0.158.0-low.jsonl`, `exec-0.159.0-low.jsonl` |
| Which efforts does Terra accept in codex? | **none, low, medium, high, xhigh, max, and ultra; minimal rejected** | 0.162.1: `none` → OK; `ultra` → OK; `minimal` → 400 "Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'." | 0.162.1 | `exec-0.162.1-{none,ultra,minimal}.jsonl` |
| Is `gpt-5.5` still runnable in codex on a ChatGPT plan? | **No** | 0.162.1 live turn → 400 `model_not_found`; absent from `model/list` on every version probed | 0.162.1 | `exec-0.162.1-gpt55.jsonl` |
| Is `gpt-6-astra-aeon` runnable? | **No** (unchanged since 09-03) | 0.162.1 → 400 `model_not_found` | 0.162.1 | `exec-0.162.1-gpt-6-astra-aeon.jsonl` |
| Is the hidden `gpt-reserve` runnable? | **Yes**, but undocumented | 0.162.1 → `agent_message "OK"` | 0.162.1 | `exec-0.162.1-gpt-reserve.jsonl` |
| Is Terra on the Gateway / fx, and with what efforts? | **Yes**: toggle + none…max | `curl ai-gateway.vercel.sh/v1/models` → `openai/gpt-6.1-terra` released 2026-10-26, `reasoning_options` toggle + effort none/low/medium/high/xhigh/max, $1/$5; `HOME=<empty> fx models --json` → 262 ids, Terra present | fx 0.0.10 | `spikes/gateway/gateway-models.json`, `spikes/fx/fx-models-0.0.10-unauth.json` |
| Is Terra in the owner's signed-in fx catalog? | **No** | `fx models --json` (real HOME, `auth: fx login`) → 139 ids, `openai/gpt-6.1-terra` absent; standard rows `gpt-5.4-mini`, `grok-4.6`, `minimax-m3`, `qwen3.8-flash`, `glm-5.3-flash` absent too | fx 0.0.10 | `spikes/fx/fx-models-0.0.10-signedin.json` |
| Does Cursor offer Terra? | **No** | `cursor-agent --list-models` → 270 rows, zero `gpt-6*` | 2026.10.22 | `spikes/cursor/list-models.txt` |
| Would the existing tests notice a naive Terra edit? | **No** | In a scratch copy of the repo: append `{id:"gpt-6.1-terra", label, hint}` as the **last** codex row, copy 6.1 Sol's effort set (no `none`), add **no** CLI floor → `bun test effort-support types orchestrator-min-cli-version agents orchestrator-discovered-efforts` = **383 pass / 0 fail**. Only a missing `hint` trips a test. | repo @ `c5cf1a2` | (scratch copy deleted) |

## 3. What we're assuming

- **A1 — The 0.159.0 floor applies to API-key codex accounts too.** It was measured only on a ChatGPT plan, the same standing as every existing floor. If API-key accounts aren't gated, they can bypass the check with `AGETOR_SKIP_CLI_VERSION_FLOOR=1`, which already exists.
- **A2 — `ultra` on Terra follows codex's catalog,** the same rule as every 5.6/6 row, and one live `ultra` turn succeeded. If OpenAI later drops `ultra` for Terra, discovered efforts hide it automatically.
- **A3 — The fx effort set is `["max","xhigh","high","medium","low","none","auto"]`,** taken from the public Gateway `reasoning_options` and not ACP-probed. Installed fx is 0.0.10 and lacks `models[].efforts`, and Terra isn't in the signed-in catalog. If it's wrong, the driver degrades to a status breadcrumb and the run doesn't fail (`applyFxEffort`).
- **A4 — Terra's `default_service_tier: "priority"` (Fast) is codex's own concern.** Agetor offers no codex speed tiers (`supportedSpeeds` codex = `["off"]`). If codex exec actually runs Terra on the Fast tier by default, agetor's "Speed: Off" would be inaccurate for Terra. The impact is cosmetic: the catalog says "1.5x speed" with no "increased usage" note, unlike Sol's "2x speed, increased usage". This was not probed (the `exec` JSON doesn't report the tier).
- **A5 — Signed-in presence of `openai/gpt-6.1-terra` may appear later** (rollouts are staged). Making it `catalogOnly` is fail-closed, so nothing changes if it does appear.
- **A6 — The codex default stays `gpt-6.1-sol`.** Terra is a cheaper middle tier, codex's own catalog keeps 6.1 Sol at priority 0 (Terra at 1), and the root rule is "default to the best available model". If the owner wants Terra as the default, a cheaper default ripples through `DEFAULT_MODEL.codex`, the unknown-id effort fallback (Terra's set includes `none`), README:78, the CLAUDE.md codex bullet, and four tests (`effort-support.test.ts:125,199`, `orchestrator-discovered-efforts.test.ts:129-160,318,326`, `orchestrator-min-cli-version.test.ts:173-195`).

## 4. What we must ask the owner

1. **Codex picker position for Terra.** Codex's own catalog order is 6.1 Sol, 6.1 Terra, 6 Astra, 6 Sol, 6 Luna.
   - Agetor's current order is Astra, Aeon, 6.1 Sol, 6 Sol, 6 Luna, Cyber, 5.6 Sol, 5.6 Terra, 5.6 Luna, 5.5, 5-codex, 5 (`src/shared/types.ts:3628-3641`).
   - *Recommendation:* directly under GPT-6.1 Sol, above GPT-6 Sol (newest-generation rows first, as with 6.1 Sol).
   - Why it matters: the `effort-support.test.ts:172` order test pins the first N ids.
2. **Codex default: keep GPT-6.1 Sol, or switch to Terra?**
   - *Recommendation:* keep 6.1 Sol (A6). Terra is the cheaper middle tier and the house rule defaults to the most capable widely available model.
   - Switching touches the files listed under A6.
3. **Effort sets.**
   - *Recommendation for codex:* `["ultra","max","xhigh","high","medium","low","none"]`, the same as `gpt-6-sol`. `none` and `ultra` were proven live (§2).
   - *Recommendation for fx:* `["max","xhigh","high","medium","low","none","auto"]` (A3).
   - Note: codex's own `model/list` omits `none`, so the live picker (discovered efforts win) won't show `none`, exactly as for `gpt-6-sol` today.
4. **Stale codex rows the probe exposed.** Choose: (a) retire, (b) fix the copy only, or (c) leave as is.
   - `gpt-5.5`: now a 400 on ChatGPT plans, absent from the catalog, and its hint claims it works.
   - `gpt-6-astra-aeon`: has never run on this account and is labeled "Unverified".
   - `gpt-5.6-terra`'s hint says "superseded by GPT-6.1 Sol" and should name 6.1 Terra. This one is a pure copy fix and should be done in any case.
   - Retiring follows migration 074's pattern (`src/bun/migrations/074_retire_fx_models.sql`): move `tasks.model`, `agent_profiles.model` and the `lastModel:codex` pref to `DEFAULT_MODEL.codex`. It **must be kind-joined on `harnesses.kind = 'codex'`**, because `"gpt-5.5"` is also a live `CURSOR_MODEL_SPECS` key (`:2768`) and fx has `openai/gpt-5.5`.
   - Retiring also changes the `effort-support.test.ts` gpt-5.5 / order assertions and the GPT-5.5 hint copy.
   - *Recommendation:* retire `gpt-5.5` (it now always fails) and fix the 5.6 Terra hint. Leave Aeon to a separate call, since the owner chose to ship it as unverified on 09-03.
5. **"Other new models": which do we curate in this change?** Discovery already shows all of them; curation buys labels, hints, effort fallbacks, position and (fx) `catalogOnly` gating.
   - Candidates for this change:
     - fx `minimax/minimax-m3.1-flash`, standard, signed-in.
     - fx `meta/muse-spark-open`, standard, signed-in.
     - fx `inception/mercury-3`, standard, signed-in; its `instant` effort has no agetor id.
     - fx `moonshotai/kimi-k3.1-pro`, `catalogOnly`.
     - fx `deepseek/deepseek-v4.1-flash-1017`, `catalogOnly`.
     - fx `meta/muse-wonder-1.0`, `catalogOnly`.
     - fx `mistral/mistral-large-4`, `catalogOnly`.
     - fx `reflection/beam`, `catalogOnly`.
     - Cursor `muse-wonder-1.0`, `muse-spark-1.3` and `deepseek-v41-flash-1017` as `CURSOR_MODEL_SPECS` entries with `effortIds`.
   - This reopens D27 (2026-10-22), which deferred the Cursor `muse-*` families to discovery.
   - *Recommendation:* add Terra everywhere it runs (codex + fx `catalogOnly`). Also curate only the successors of rows agetor already curates: fx `minimax/minimax-m3.1-flash` and `moonshotai/kimi-k3.1-pro`, and cursor + fx DeepSeek V4.1 Flash 1017. Keep D27 for the Meta Muse families unless the owner wants them.
6. **fx standard rows that dropped out of the owner's signed-in catalog** (`openai/gpt-5.4-mini`, `spacexai/grok-4.6`, `minimax/minimax-m3`, `alibaba/qwen3.8-flash`, plus the known `zai/glm-5.3-flash`). Choose: leave them (the merge hides them on that account, and they are still in the unauthenticated catalog), move them to `catalogOnly`, or retire them.
   - *Recommendation:* leave them, and only refresh the dated measurement comment and the CLAUDE.md fx bullet (139 signed-in / 262 unauth on 2026-10-26).
   - Retiring needs a migration, and these ids still exist on the Gateway.
7. **Hidden `gpt-reserve`.** It is undocumented and hidden in codex's own picker, but it runs. *Recommendation:* don't curate it. It isn't announced, and discovery drops hidden rows on purpose.
8. **Codex speed tiers (A4).** Terra (and 6.1 Sol) advertise a codex "Fast" service tier. Exposing codex Fast in agetor's Speed picker is a separate feature. *Recommendation:* out of scope; record it in the completeness ledger.

## 5. Completeness inventory

Line numbers are at `c5cf1a2`.

### Callers and readers of what changes

All of the following are table-driven: they read `AGENT_OPTIONS`, `MODEL_EFFORT_SUPPORT`, `MODEL_MIN_CLI_VERSION` and `DEFAULT_MODEL`, and need no code change.

- **Pickers:**
  - `NewTaskForm`, RunPanel task details, `TaskLaunchPickers` (the Resolve-Conflicts / Create-from-issue / Clone dialogs and Settings → Agents), all via `mergeModelOptions` (`src/shared/model-options.ts`).
  - `agetor add` / `profile add|edit` (`src/cli/commands/add.ts`, which reads `DEFAULT_MODEL.codex`).
  - The TUI.
- **Pre-flight 1b:**
  - `minCliVersionError` in `src/bun/orchestrator.ts`, called from `startTaskInner`, `spawnCodexTurnNow`, `sendInput` and the clone route (`src/bun/server.ts`).
  - `upgradeHintFor` in `src/bun/agent-status.ts`.
- **Effort resolution:**
  - `supportedEfforts` (`types.ts:3467`) and `effortsAllowed`.
  - `defaultEffortFor` and `effortFallbackForModelChange` in `orchestrator.ts`.
  - The PATCH null-clear guard in `server.ts`.
- **Argv:** codex `--model <id>` and `-c model_reasoning_effort=<id>` pass through verbatim (`src/bun/agents.ts`). fx sends the Gateway id over ACP; effort and speed go through `applyFxEffort` / `applyFxSpeed` (`src/bun/fx-acp.ts`).
- **Discovery:** `parseCodexModelList` (`agent-discovery.ts:98-140`, which drops hidden rows) and `parseFxModels`. These give Terra a discovered label and efforts today with no change.

### Propagation surface (edit sites)

**`src/shared/types.ts`:**
- `AGENT_OPTIONS.codex.models` (`:3628-3641`): add the Terra row and hint; fix the `gpt-5.6-terra` hint (`:3637`); and, per Q4, the `gpt-5.5` hint or retirement (`:3638`).
- `MODEL_EFFORT_SUPPORT.codex` (`:3241-3290`): add a Terra row plus a dated evidence paragraph.
- `MODEL_MIN_CLI_VERSION.codex` (`:2638-2646`) and its doc comment (`:2615-2637`): add `"gpt-6.1-terra": "0.159.0"`.
- `MODEL_EFFORT_SUPPORT.fx` (`:3343-3407`): add a row plus a dated comment. The header comment's "a 35th …" sequence (`:3313-3329`) gains a sentence.
- `AGENT_OPTIONS.fx.models`: add a `catalogOnly` row after `google/gemini-4-argon` (`:3826`), plus a dated history-comment paragraph (`:3709-3792`). That makes 21 `catalogOnly` rows and 34 curated.
- fx `efforts` comment "31 of the 33" (`:3835-3842`) becomes 32 of 34.
- The `AgentOption.catalogOnly` doc comment (`:2465-2478`) still quotes 2026-09-14 counts. Refresh it or leave it historical.
- Any Q5 rows: fx standard/`catalogOnly` rows plus effort entries, and `CURSOR_MODEL_SPECS` entries (`:2648-3034`).
  - A Cursor spec needs `effortIds`, and `fastEfforts` only if `-fast` ids exist. None exist for the muse or deepseek-1017 families.
  - Cursor effort table entries are derived automatically (`:3264-3269`).

**Count and prose comments outside `types.ts`:**
- `src/bun/orchestrator.ts:6538-6551`: "23 of its 36 curated … remaining 13". This is **already stale**: after the 10-22 retirements the truth is 31 of 33 / 2. Fix it in the same wave.
- `src/bun/agent-discovery.ts:548-555` and `src/bun/fx-acp.ts:510-515`: "postdate this measurement" enumerations gain the new id(s).

**Tests that pin the catalog** (each must be updated in step):
- `src/bun/effort-support.test.ts`:
  - `:172-185` picker-order test (first 9 ids).
  - `:207-222` `MODEL_MIN_CLI_VERSION` exact-ids test (becomes 6 ids).
  - `:186-189` `gpt-5.5` effort test (only if it is retired).
  - Add a new "GPT-6.1 Terra supports ultra through none" test.
- `src/bun/orchestrator-min-cli-version.test.ts:196-240`: add a Terra case, 0.158.0 refused / 0.159.0 allowed. The existing `FAKE_CODEX_VERSION` seam covers it.
- `src/bun/agents.test.ts:643-650,808-815`: optional verbatim-passthrough cases.
- `src/shared/types.test.ts`:
  - `FX_EFFORT_MODELS` (`:183-235`, count `31` → 32, comment "33" → 34).
  - The `catalogOnly` set test (`:319-363`, `size 20` → 21, "twenty" in test names).
  - `:373` name.
- `e2e/fx-models.spec.ts:60-100`: `EXCLUDED_FX_OPTION_LABELS` gains "GPT-6.1 Terra", and the "twelve of the twenty" prose changes.

**Docs:**
- `CLAUDE.md:74` (codex bullet):
  - The `MODEL_MIN_CLI_VERSION` parenthetical gains `gpt-6.1-terra → 0.159.0`.
  - The `ultra` sentence ("offered for Astra/Aeon/GPT-6.1 Sol/GPT-6 Sol/…") gains GPT-6.1 Terra.
  - The 2026-10-14 `gpt-5.5` retirement sentence: per Q4.
- `CLAUDE.md:77` (fx bullet):
  - "twenty catalog-gated rows" enumeration.
  - A new "On 2026-10-26 it read 262 unauth / 139 signed-in" sentence after the 2026-10-22 one.
  - The effort-group sentence after "the 36th … `google/gemini-4-argon`".
- `README.md:78`: the codex default cell changes only if Q2 says switch. README's general discovery and floor copy at `:47` already covers Terra.
- The new plan doc, `docs/plans/add-gpt-6-1-terra.md`.

**Bundles / profiles / snapshots:**
- Agent-profile and pipeline snapshots and bundle files store `model` verbatim. Nothing changes for an added row.
- A retirement migration (Q4) deliberately does **not** rewrite frozen `tasks.agent_profile` / `tasks.pipeline_run` JSON (074's rule). Bundle import of a retired id shows an `unknown-model` warning only (`bundle-import.ts`).

### Existing data a migration would have to backfill

- **Adding rows:** none.
- **Retiring `gpt-5.5` (codex):** `tasks` rows with `model='gpt-5.5'` whose `agent` is a codex-kind harness; `agent_profiles` rows with the same constraint on `harness_id`; and the `preferences` row `lastModel:codex = 'gpt-5.5'`.
  - Volumes are unknown here. Reading the prod DB is out of bounds for this step; the planner can measure `~/.agetor-dev` or ask.
  - Migration test pattern: `src/bun/migrate.test.ts` (as in `163c2a2` / 074).
  - Next free number: **075**.

### Docs, config and examples describing current behavior

- `CLAUDE.md` codex and fx bullets.
- `README.md:47,78,88`.
- The precedent plans `docs/plans/add-gpt-6-1-sol.md` and `docs/plans/add-gpt-6-sol-and-luna.md`.
- The D27 record: `docs/plans/fx-0.0.14-and-cursor-updates-grill.md:54,82`.

### What the change would orphan

- Adding rows orphans nothing.
- Retiring `gpt-5.5` orphans the codex `gpt-5.5` effort entry and its test. The cursor `gpt-5.5` spec and the fx `openai/gpt-5.5` row are **separate and stay**.

## 6. Runnability

- **Start locally:** `bun run dev:hmr` (UI) or `bun run dev` (it needs `bun run build` first). Both use `AGETOR_DATA_DIR=~/.agetor-dev`. **Never run against prod `~/.agetor`**: the memory note "Dogfood in dev dir" applies, and so does "CLI smoke hits prod core": `--no-daemon` still talks to the running prod core.
- **PATH in this worktree:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`. The clone-endpoint tests need `claude` on PATH. This worktree has **no `node_modules`**: the targeted tests above passed without one, but run `bun install` before typecheck or e2e.
- **Typecheck:** `bun run typecheck`.
- **Unit and integration tests, targeted:**
  - `bun test src/shared/types.test.ts src/bun/effort-support.test.ts src/bun/agents.test.ts src/bun/orchestrator-discovered-efforts.test.ts src/bun/orchestrator-min-cli-version.test.ts src/bun/orchestrator-codex-queue-floor.test.ts src/bun/clone-endpoint.test.ts src/bun/agent-discovery.test.ts src/shared/cli-version.test.ts`
  - Add `src/bun/migrate.test.ts` if there is a retirement.
- **Full suite:** `bun test`. Check `uptime` first: the CLI suite stalls at load 30+ (load was ~5 at investigation time). Known pre-existing failures are tmux-socket ×2 and one reconcile-cancel test.
- **E2E harness:** Playwright via `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` (not `bunx`; run one Playwright run at a time). The fx stub catalog in `e2e/fixtures.ts` is frozen at 4 ids, so a new `catalogOnly` label only joins `EXCLUDED_FX_OPTION_LABELS`.
  - As with 6.1 Sol, e2e is likely **not applicable** to a data-only catalog change.
  - The exception would be a Q4 retirement surfacing in UI. Even that is covered at the migration and unit layers.

## 7. Risks & blast radius

- **Tests don't pin correctness of a new codex row** (proved, §2). A naive append with no floor and a wrong effort set passes everything. The plan must add tests:
  - a Terra effort-set test (with `none`);
  - extend the `MODEL_MIN_CLI_VERSION` exact-ids test to six;
  - an orchestrator 0.158.0-refused / 0.159.0-allowed case;
  - update the picker-order test to include Terra's position.
- **Floor:** adding it is additive. The only new refusal is "codex < 0.159.0 + gpt-6.1-terra", which fails today anyway, after a run row and worktree exist. The owner's installed 0.162.1 passes.
- **A codex retirement migration must be kind-joined:** `gpt-5.5` is also a live Cursor model key. An unjoined `UPDATE tasks SET model=… WHERE model='gpt-5.5'` would wrongly move Cursor tasks.
- **fx counts move in lockstep** across four `types.ts` comments, `orchestrator.ts`, `agent-discovery.ts`, `fx-acp.ts`, `types.test.ts` (×2 assertions), the e2e prose and CLAUDE.md. The 6.1 Sol plan's D8 rule applies: re-count from the file, never copy.
- **Pre-existing comment drift to sweep:** `orchestrator.ts:6538` "23 of its 36"; the `gpt-5.5` hint's "works on ChatGPT plans"; the `gpt-5.6-terra` hint naming 6.1 Sol as its successor.
- **Drift behaves gracefully:** discovered efforts override curated ones, and the fx driver validates effort and speed at runtime. A wrong curated effort set is a picker-hint problem, never a failed run.
- **Rollback:** reverting the catalog commits is enough for added rows (they are data only). A retirement migration is one-way, like 074; a rollback is a new migration.
