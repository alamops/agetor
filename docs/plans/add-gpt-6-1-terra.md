# Plan — Add GPT-6.1 Terra, curate the other new models, retire codex GPT-5.5

| Field | Value |
| --- | --- |
| Date | 2026-10-26 |
| Source | Pipeline goal "OpenAI announced GPT 6.1 Terra — add support; check for other new models we can add too" (https://openai.com/index/introducing-gpt-6-1-terra/); `docs/plans/add-gpt-6-1-terra-investigation.md`; `docs/plans/add-gpt-6-1-terra-grill.md` (D1–D21) |
| Flags | none |
| Gates | grilled + approved by owner — grill D1–D21; plan approved 2026-10-26 with P1 (include 076), P2 (wider 075 effort rule), P3 (DeepSeek V4.1 Flash 1017 at index 1), P4 + P7 included (AskUserQuestion at hand-off) |
| Branch | `feature/add-gpt-6-1-terra` (the agetor task branch; do not cut another) |
| Base SHA | `c5cf1a2` |

## 1. Objective & success criteria

Add OpenAI's **GPT-6.1 Terra** (`gpt-6.1-terra`, released 2026-10-26) to every agetor harness that can run it: codex and fx. Curate the **eight other new fx models** and **three new Cursor families** (D1). **Retire codex GPT-5.5**, which now answers a 400 on ChatGPT plans (D2). Nothing about a harness default changes (D5, D15).

Done means:

1. **Codex picker** (New Task form, task details, both launch dialogs, Settings → Agents, `agetor add`). The rows, in order, are `gpt-6-astra, gpt-6-astra-aeon, gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-cyber, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5-codex, gpt-5`. That is 12 rows, and `gpt-5.5` is gone (D4, D2). Terra carries the D16 hint. GPT-5.6 Terra's hint names GPT-6.1 Terra as its successor.
2. **Codex efforts.**
   - The curated set for Terra is `ultra, max, xhigh, high, medium, low, none` (D10).
   - Codex's own catalog omits `none`, so the live picker (where discovered efforts win) shows ultra…low, exactly as for `gpt-6-sol` today.
   - `MODEL_EFFORT_SUPPORT.codex` has no `gpt-5.5` key.
3. **CLI floor.** `MODEL_MIN_CLI_VERSION.codex["gpt-6.1-terra"] === "0.159.0"`. Pre-flight 1b refuses Terra on codex 0.158.0, before any run row or worktree exists, and lets 0.159.0 through (D12).
4. **fx catalog.** fx offers 42 curated rows: 16 standard and 26 `catalogOnly`.
   - New standard rows: `minimax/minimax-m3.1-flash`, `meta/muse-spark-open`, `inception/mercury-3`.
   - New `catalogOnly` rows: `openai/gpt-6.1-terra`, `moonshotai/kimi-k3.1-pro`, `deepseek/deepseek-v4.1-flash-1017`, `meta/muse-wonder-1.0`, `mistral/mistral-large-4`, `reflection/beam`.
   - Each new row has a `MODEL_EFFORT_SUPPORT.fx` set: 40 effort models, 2 no-effort.
   - Every count comment, assertion and doc agrees, re-counted from the file (D13, D20).
   - The numbers in this item assume T0 (§4) doesn't move a model across the `catalogOnly` line. If it does, T0's §2b record is the authority.
5. **Cursor catalog.** Cursor offers `muse-wonder-1.0`, `muse-spark-1.3` and `deepseek-v41-flash-1017` as specs whose `effortIds` match `cursor-agent --list-models`. Only `muse-spark-1.3` sets `supportsMaxMode` (its bracket form was probed live, §2). None has `fastEfforts`. All 17 variant ids are covered by the catalog.
6. **Migration 075** (`075_retire_codex_gpt_5_5.sql`) moves codex-kind `tasks.model`, codex-kind `agent_profiles.model` and the `lastModel:codex` preference from `gpt-5.5` to `gpt-6.1-sol`.
   - It is kind-joined on `harnesses.kind = 'codex'`.
   - On the rows it moves, an effort GPT-6.1 Sol rejects becomes `high` (D2; P2 widens `none` to "anything 6.1 Sol rejects").
   - It leaves Cursor `gpt-5.5`, fx `openai/gpt-5.5`, orphans, frozen snapshots, `updated_at` and `lastEffort:codex` alone (D19).
   - It is idempotent.
7. **Migration 076** (`076_normalize_cursor_new_families.sql`, P1) folds stored Cursor variant ids of the three new families into base id + effort, with `speed = 'off'`. It covers cursor-kind `tasks` and `agent_profiles` and the `lastModel:cursor` preference, following the 055/056/060/062/064 precedent.
8. **Copy.** CLAUDE.md (codex + fx bullets), README (a Codex retirement note) and the stale count comments in `orchestrator.ts` / `agent-discovery.ts` / `fx-acp.ts` / `types.ts` are true after the change (D20).
9. **Checks.**
   - `bun run typecheck` and the full `bun test` are green, apart from the three known pre-existing failures.
   - The migration dry run on a copy of the dev DB matches §5.
   - The three live dev-app smokes pass: codex Terra, fx MiniMax M3.1 Flash, cursor DeepSeek V4.1 Flash 1017 (D8).

## 2. Context & constraints (grounded)

Line numbers are at `c5cf1a2`. The investigation's measurements were taken on 2026-10-26: codex-cli 0.155.1–0.162.1, fx 0.0.10, cursor-agent 2026.10.22. The ones this plan depends on:

**GPT-6.1 Terra.**
- Codex `model/list` first lists `gpt-6.1-terra` on 0.159.0.
  - A live turn on 0.158.0 answers 400 `model_not_found` ("…not supported when using Codex with a ChatGPT account").
  - On 0.159.0 it answers OK.
- On 0.162.1, efforts `none`, `low` and `ultra` run live, and `minimal` answers 400 ("Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'").
- The catalog row's efforts are low…max plus `ultra`, with no `none`, default `low`.
- On the Gateway it is `openai/gpt-6.1-terra` with `reasoning_options` toggle + effort none/low/medium/high/xhigh/max, at $1/$5. There is a `-fast` twin.
- It is absent from the owner's signed-in fx catalog (139 ids, 0.0.10).
- Cursor has no `gpt-6*` ids.

**Codex GPT-5.5.**
- It is absent from `model/list` on every version probed, and a live 0.162.1 turn answers 400.
- Its hint (`src/shared/types.ts:3639`) still claims "works on ChatGPT plans; codex retires it on 2026-10-14".

**Plan-time re-measure (2026-10-26, D11).** Artifacts are in the session scratchpad `plan-measure/`.

The Gateway's public `https://ai-gateway.vercel.sh/v1/models` lists 482 entries. `reasoning_options` for each new fx id:

| Gateway id | Name | Context / max out | $/MTok in/out | `reasoning_options` | Curated fx set (+`auto`) |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-6.1-terra` | GPT-6.1 Terra | 1.05M / 128K | 1 / 5 | toggle + none, low, medium, high, xhigh, max | `max, xhigh, high, medium, low, none, auto` |
| `minimax/minimax-m3.1-flash` | MiniMax-M3.1-Flash | 1M / 1M | 0.15 / 0.60 | low, medium, high, xhigh, max | `max, xhigh, high, medium, low, auto` |
| `meta/muse-spark-open` | Muse Spark Open | 1M / 1M | 1.25 / 4.25 | low, medium, high, xhigh | `xhigh, high, medium, low, auto` |
| `inception/mercury-3` | Mercury 3 | 1M / 131K | 0.10 / 0.35 | instant, low, medium, high | `high, medium, low, auto` (`instant` omitted, D6) |
| `moonshotai/kimi-k3.1-pro` | Kimi K3.1 Pro | 1M / 1M | 2 / 10 | low, high, max | `max, high, low, auto` |
| `deepseek/deepseek-v4.1-flash-1017` | DeepSeek V4.1 Flash 1017 | 1M / 1M | 0.075 / 0.30 | toggle + none, low, high, max | `max, high, low, none, auto` |
| `meta/muse-wonder-1.0` | Muse Wonder | 1M / 1M | 4 / 20 | minimal, low, medium, high, xhigh, max | `max, xhigh, high, medium, low, minimal, auto` |
| `mistral/mistral-large-4` | Mistral Large 4 | 512K / 262K | 1.36 / 4.18 | toggle + none, high | `high, none, auto` |
| `reflection/beam` | Beam 1.0 | 1M / 131K | 0 / 0 | low, medium, high, xhigh, max | `max, xhigh, high, medium, low, auto` |

- The `-fast`, `-highspeed` and `-free` twins carry the same options and stay discovery-only (D13).
- Drift found along the way: the Gateway now reports `minimax/minimax-m3` at **512K / 512K**, while its agetor hint says "1M context · 1M output" (`types.ts:3804`). See P4 in §8.

`cursor-agent --list-models` (2026.10.22-27dcf5f, 272 lines):
- `muse-wonder-1.0-{minimal,low,medium,high,xhigh,max}`.
- `muse-spark-1.3-{minimal,low,medium,high,xhigh,max}`. Every row is labeled "Muse Spark 1.3 1M …".
- `deepseek-v41-flash-1017-{none,low,medium,high,max}`. This includes `medium`, which the Gateway entry lacks.
- None of these has a `-fast` form.

Live `cursor-agent -p --trust --mode ask --output-format stream-json "Reply with exactly OK"` probes (one paid request each):

| `--model` | Result |
| --- | --- |
| `muse-spark-1.3[context=1m,effort=high]` | **OK** (rc 0). Max Mode works, and this is exactly the string `cursorModelArg` will build, since there is no fast tier and so no `fast=`. |
| `muse-wonder-1.0[context=1m,effort=high]` | **Rejected** ("Cannot use this model: …"). |
| `deepseek-v41-flash-1017[context=1m,effort=high]` | **Rejected**. |
| `muse-wonder-1.0-low` | OK. |

This matches the fleet rule (jubarteai `421157fb`): only rows Cursor labels "1M" take the bracket.

**Existing data (read-only `sqlite3 -readonly`, 2026-10-26).**
- **Prod `~/.agetor`:**
  - 10 codex-kind tasks on `gpt-5.5`, all archived, all at effort `high`.
  - 0 agent profiles on it, and no orphan rows.
  - `lastModel:codex` is already `gpt-6.1-sol`.
  - No row uses a new-family Cursor variant id.
  - So 075 moves 10 archived rows with no effort fix-up in prod, and 076 is a no-op there.
- **Dev `~/.agetor-dev`:** at migration 051 (no `agent_profiles` table yet), 0 `gpt-5.5` rows, and no codex preferences. Its first launch of this branch will run 052–076.

**Code anchors** (`src/shared/types.ts` unless noted):

- **`AgentOption.catalogOnly` doc comment:** `:2465-2477`. Its counts are stale (2026-09-14).
- **`DEFAULT_MODEL`:** `:2511-2568`. Unchanged (D5, D15).
- **`MODEL_MIN_CLI_VERSION`:**
  - Doc comment `:2615-2637`; table `:2638-2646`.
  - Pre-flight 1b reads it in `src/bun/orchestrator.ts`: `startTaskInner`, `spawnCodexTurnNow`, and the clone route in `server.ts`. It needs no code change.
- **`CURSOR_MODEL_SPECS`:**
  - `:2648-3034`. The trailing third-party block is `kimi-k3` `:3022`, `kimi-k2.7-code` `:3028`, `glm-5.2` `:3029-3033`.
  - `cursorModelArg` `:3056-3076`: with `maxMode && supportsMaxMode` it builds `${model}[context=1m,effort=…]`, adding `fast=` only for fast-capable pairs.
  - `cursorModelIdCoveredByCatalog` `:3048`. Its callers filter discovered rows: `NewTaskForm.tsx:414`, `RunPanel.tsx:7647`, `TaskLaunchPickers.tsx:296,335`, `src/cli/commands/add.ts:677`. That filter is why P1 is needed.
- **`EFFORT_OPTIONS`:** `:3154-3164`, order ultra, max, xhigh, high, medium, low, minimal, none, auto.
- **`MODEL_EFFORT_SUPPORT` doc header:** `:3175-3180` ("GPT-6.1 Sol → …", "gpt-5.5 / gpt-5 / gpt-5-codex → …").
- **Codex effort table:** `:3236-3281`. The dated evidence paragraphs end `:3268`; `gpt-6.1-sol` is at `:3269`, `gpt-5.5` at `:3278`.
- **Cursor efforts:** derived from specs at `:3282-3287`.
- **fx effort table:**
  - Header comment `:3300-3343`, which has the ordinal sequence "a 29th … a 35th".
  - Rows `:3344-3409`; the last is `google/gemini-4-argon` `:3408`.
- **Codex models:** `:3628-3642`. `gpt-5.6-terra` hint `:3637`; `gpt-5.5` row `:3639`.
- **fx models:**
  - History comment `:3709-3792`, whose last paragraph is 2026-10-22: "13 standard + 20 catalogOnly rows, 33 curated ids total".
  - Rows `:3793-3827`: standard `:3794-3806`, `catalogOnly` `:3807-3826`.
  - `efforts` comment "31 of the 33 … other 2" `:3833-3840`.
- **Stale count comments outside `types.ts`:**
  - `src/bun/orchestrator.ts:6538-6552`: "23 of its 36 … remaining 13", with the example `zai/glm-4.7`, which now has a set. The truth today is 31/2.
  - `src/bun/agent-discovery.ts:548-555` and `src/bun/fx-acp.ts:510-515`: the "postdate this measurement" enumerations.
- **Migrations:**
  - The last one is `074_retire_fx_models.sql`, registered at `src/bun/migrations/index.ts:104` (import) and `:187` (entry).
  - Test precedents in `src/bun/migrate.test.ts`:
    - "074 is the last registered migration" `:1151-1161`, which asserts `at === migrations.length - 1` and so **breaks the moment 075 lands**.
    - The 074 data test `:1365-1434`.
    - `makeModelMigrationDb` `:848`, whose schema still has the pre-072 `fast` column.
    - Cursor-normalization tests for 055/056/060/062/064, imported at `:6-10`.
- **Tests pinning today's catalog:**
  - `src/bun/effort-support.test.ts`:
    - Picker order `:172-185` (first 9).
    - The `gpt-5.5` effort test `:187-190`.
    - The unknown-id fallback `:199-205`.
    - `MODEL_MIN_CLI_VERSION` exact five `:207-227`.
    - Cursor spec tests `:455-560`, e.g. Gemini 4 Argon `:494`, Max Mode `:538`, `cursorModelArg` `:546`.
  - `src/bun/orchestrator-min-cli-version.test.ts:196-229`: the 6.1 Sol 0.158/0.159 pair, which is the pattern for Terra.
  - `src/bun/agents.test.ts:679-689`: the "codex model 'gpt-5.5' passes through verbatim" test.
  - `src/shared/types.test.ts`:
    - `FX_EFFORT_MODELS` `:176-238`: `31`, `33` ×2.
    - The `catalogOnly` set `:319-370`: "twenty", `size 20`.
    - `:373` name.
  - `src/shared/gemini-4-argon-catalog.test.ts`: the precedent for a per-change test through the real `mergeModelOptions`.
  - `e2e/fx-models.spec.ts:60-103`: `EXCLUDED_FX_OPTION_LABELS` and its prose "two ordinary … twelve of the twenty".
  - Incidental codex `gpt-5.5` literals: `src/cli/config.test.ts:25-26` and `src/bun/claude-local-setting.test.ts:1011,1026`.
  - Cursor `gpt-5.5` literals stay as they are, because they are the live Cursor spec: `src/shared/speed.test.ts:80-89` and `effort-support.test.ts:547-548`.
- **Docs:**
  - `CLAUDE.md:74` (codex bullet): the `MODEL_MIN_CLI_VERSION` parenthetical, "only GPT-5.5 → GPT-5.6 Sol, retiring 2026-10-14", and the `ultra` list "(offered for Astra/Aeon/GPT-6.1 Sol/GPT-6 Sol/GPT-5.6 Sol/Terra/Cyber, not either Luna)".
  - `CLAUDE.md:77` (fx bullet): "13 standard rows … plus twenty catalog-gated rows (…)", the dated catalog-count sentences ending "On 2026-10-22 it read **264 ids unauthenticated on 0.0.14** and **145 …**", the effort-group sentence that ends with "`google/gemini-4-argon`, the 36th", and "`MODEL_EFFORT_SUPPORT.fx` is that per-model table (… refreshed 2026-10-22 …)".
  - `README.md`: no Codex notes section exists. The fx notes at `:96-106` carry the retired-models precedent bullet (`:99`).

**Runnability.**
- This worktree has **no `node_modules`**, so run `bun install` first.
- Set `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- `bun run dev` / `dev:hmr` use `AGETOR_DATA_DIR=$HOME/.agetor-dev` and `AGETOR_API_PORT=4318` (`package.json:8-9`). Prod listens on 4317, and this pipeline runs inside it, so **nothing in this plan may target `~/.agetor` or port 4317**.
- Installed: `codex-cli 0.162.1`, fx `0.0.10`, cursor-agent `2026.10.22`.
- Load at plan time was about 4–5.

## 2b. T0 record — fx 0.0.14 re-measure (2026-10-26)

**Upgrade.** `https://fx.sh/setup.sh` was downloaded to the scratchpad and read first: it fetches `https://releases.fx.sh/<latest>/fx-macos-aarch64.tar.gz` and moves the binary to `~/.local/bin/fx`, nothing else (`~/.local/bin` is already on `PATH`, so it edits no rc file). `releases.fx.sh/latest.txt` read `v0.0.14`. After running it, `fx --version` reports **0.0.14** (was 0.0.10). No fallback was needed (rule f).

**Auth** (`fx status --json`, real HOME): `auth: "fx login"`, `auth_expired` absent, `auth_refreshable: true`, `permission_mode: "auto"`. The signed-in view is usable, so rule (d) does not apply.

**Views** (`fx models --json`, both bounded with `perl -e 'alarm 60'`):

- Unauthenticated (`HOME=<empty scratch dir>`): **262** ids (`private_models_hidden: true`).
- Signed-in (owner's HOME): **139** ids (`private_models_hidden: false`).
- Both envelopes carry 0.0.14's `models[]` array (`id`, `name`, `efforts`, `fast`, `ultrafast`).

**Per-id table** (all 33 curated ids, then the 9 new ones; "Matches" compares 0.0.14's `efforts` plus `auto`, in `EFFORT_OPTIONS` order, against the set in `types.ts` at `c5cf1a2` or the §2 Gateway set for a new id):

| fx id | Curated | Unauth | Signed-in | 0.0.14 `models[].efforts` | Matches curated set (+`auto`) |
| --- | --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4-flash` | standard | yes | yes | none, low, medium, high | yes |
| `zai/glm-5.3-flash` | standard | yes | no | low, high, max | yes |
| `zai/glm-5v-turbo` | standard | yes | yes | none, low, medium, high | yes |
| `zai/glm-4.7` | standard | yes | yes | none, low, medium, high | yes |
| `openai/gpt-5.2` | standard | yes | yes | none, minimal, low, medium, high, xhigh | yes |
| `openai/gpt-5.1-codex-max` | standard | yes | yes | none, low, medium, high | yes |
| `openai/gpt-5.4-mini` | standard | yes | no | none, minimal, low, medium, high, xhigh | yes |
| `spacexai/grok-4.6` | standard | yes | no | low, medium, high, xhigh | yes |
| `spacexai/grok-build-0.1` | standard | yes | yes | none, low, medium, high | yes |
| `moonshotai/kimi-k2.7-code` | standard | yes | yes | none, low, medium, high | yes |
| `minimax/minimax-m3` | standard | yes | no | (none) | yes |
| `alibaba/qwen3.8-flash` | standard | yes | no | low, medium, xhigh | yes |
| `google/gemini-2.5-flash` | standard | yes | yes | none, low, medium, high | yes |
| `anthropic/claude-opus-5` | catalogOnly | yes | no | none, low, medium, high, xhigh, max | yes |
| `anthropic/claude-sonnet-5` | catalogOnly | yes | no | none, low, medium, high, xhigh, max | yes |
| `openai/gpt-5.5` | catalogOnly | yes | no | none, minimal, low, medium, high, xhigh | yes |
| `google/gemini-3.1-pro-preview` | catalogOnly | yes | no | low, high | yes |
| `google/gemini-3.8-flash` | catalogOnly | yes | no | low, high | yes |
| `moonshotai/kimi-k3` | catalogOnly | yes | no | low, high, max | yes |
| `anthropic/claude-fable-5.1` | catalogOnly | yes | no | low, medium, high, xhigh, max | yes |
| `anthropic/claude-haiku-4.5` | catalogOnly | yes | no | (none) | yes |
| `openai/gpt-6-astra` | catalogOnly | yes | no | low, medium, high, xhigh, max | yes |
| `openai/gpt-5.6-sol` | catalogOnly | yes | no | none, minimal, low, medium, high, xhigh, max | yes |
| `zai/glm-5.3` | catalogOnly | yes | no | low, high, max | yes |
| `deepseek/deepseek-v4-pro` | catalogOnly | yes | no | none, low, high, max | yes |
| `spacexai/grok-4.7` | catalogOnly | yes | no | low, medium, high, xhigh | yes |
| `anthropic/claude-opus-5.5` | catalogOnly | yes | no | low, medium, high, xhigh, max | yes |
| `openai/gpt-6-sol` | catalogOnly | yes | no | none, low, medium, high, xhigh, max | yes |
| `openai/gpt-6-luna` | catalogOnly | yes | no | none, low, medium, high, xhigh, max | yes |
| `anthropic/claude-sonnet-5.5` | catalogOnly | yes | no | low, medium, high, xhigh, max | yes |
| `openai/gpt-6.1-sol` | catalogOnly | yes | no | low, medium, high, xhigh, max | yes |
| `anthropic/claude-haiku-5.5` | catalogOnly | yes | no | none, low, medium, high, xhigh, max | yes |
| `google/gemini-4-argon` | catalogOnly | yes | no | low, medium, high | yes |
| `openai/gpt-6.1-terra` | new | yes | no | none, low, medium, high, xhigh, max | yes |
| `minimax/minimax-m3.1-flash` | new | yes | yes | low, medium, high, xhigh, max | yes |
| `meta/muse-spark-open` | new | yes | yes | low, medium, high, xhigh | yes |
| `inception/mercury-3` | new | yes | yes | instant, low, medium, high | yes (`instant` omitted, D6) |
| `moonshotai/kimi-k3.1-pro` | new | yes | no | low, high, max | yes |
| `deepseek/deepseek-v4.1-flash-1017` | new | yes | no | none, low, high, max | yes |
| `meta/muse-wonder-1.0` | new | yes | no | minimal, low, medium, high, xhigh, max | yes |
| `mistral/mistral-large-4` | new | yes | no | none, high | yes |
| `reflection/beam` | new | yes | no | low, medium, high, xhigh, max | yes |

**Reconciliation outcome.**

- (a) All 9 new ids are present in the unauthenticated view, and each one's 0.0.14 `efforts` plus `auto` equals its §2 Gateway set exactly (Mercury 3 minus `instant`, D6). The §2 sets stand.
- (b) Every curated row present in the signed-in view (`deepseek/deepseek-v4-flash`, `zai/glm-5v-turbo`, `zai/glm-4.7`, `openai/gpt-5.2`, `openai/gpt-5.1-codex-max`, `spacexai/grok-build-0.1`, `moonshotai/kimi-k2.7-code`, `google/gemini-2.5-flash`) — and, for completeness, every other curated row — already matches 0.0.14. **No existing effort set changes.**
- (c) Gates follow signed-in presence (D13) and match §1.4 exactly: `minimax/minimax-m3.1-flash`, `meta/muse-spark-open` and `inception/mercury-3` are signed-in → **standard**; `openai/gpt-6.1-terra`, `moonshotai/kimi-k3.1-pro`, `deepseek/deepseek-v4.1-flash-1017`, `meta/muse-wonder-1.0`, `mistral/mistral-large-4` and `reflection/beam` are absent from the signed-in view → **catalogOnly**. No existing row crosses the line.
- The 5 standard rows absent from the signed-in view are unchanged from D7: `zai/glm-5.3-flash`, `openai/gpt-5.4-mini`, `spacexai/grok-4.6`, `minimax/minimax-m3`, `alibaba/qwen3.8-flash` (left in place).
- (e) Did not fire: no new id is absent from both views, and no default changes.

**Final counts (unchanged from §3):** fx **42** curated rows = **16** standard + **26** `catalogOnly`; **40** effort + **2** no-effort (`minimax/minimax-m3`, `anthropic/claude-haiku-4.5`).

Side note (not acted on, D18): 0.0.14 flags `fast: true` on `openai/gpt-6.1-terra` and `deepseek/deepseek-v4.1-flash-1017`, which the discovered speed picker already surfaces on its own; nothing in the curated table carries speed flags.

## 3. Approach & key decisions

The change is **data-first**: catalog rows, effort tables, one floor entry, two migrations and copy. Every consumer (pickers, Pre-flight 1b, effort resolution, argv building, discovery) is table-driven, and the investigation and this plan's grounding confirmed that none needs a code change. The proven risk is that **tests don't pin correctness**: a naive Terra append passed 383/0 (investigation §2). So this plan writes the tests in the **same wave** as the data, against values this section pins.

- **Codex (D2, D4, D10, D12, D16, D17).** Insert Terra after 6.1 Sol with the D16 hint. Remove the `gpt-5.5` row and its effort key. Add the floor. *Evidence:* the version table and live turns in §2. No `gpt-reserve` (D17). No change to the default (D5).
- **fx (D1, D6, D10, D11, D13, D14, D16).**
  - **Effort sets** are the Gateway `reasoning_options` from §2 plus `auto`, in `EFFORT_OPTIONS` order. T0 then reconciles them against fx 0.0.14's `models[].efforts` (D9), and 0.0.14 wins where they differ, which is the 2026-10-22 precedent.
  - **Gating:** a row is `catalogOnly` exactly when the model is absent from the owner's signed-in catalog (D13).
  - **Placement** (D14):
    - A successor sits directly above its predecessor: `minimax/minimax-m3.1-flash` above `minimax/minimax-m3`, and `moonshotai/kimi-k3.1-pro` above `moonshotai/kimi-k3`.
    - `deepseek/deepseek-v4.1-flash-1017` sits **directly below** `deepseek/deepseek-v4-flash`, at index 1. The default row must stay first (`types.test.ts:132`), so "next to" can only mean below. It is a `catalogOnly` row inside the standard block. No test pins grouping by flag, and the flag, not the position, decides gating (P3).
    - New families go at the end of their group: `meta/muse-spark-open` and `inception/mercury-3` after `google/gemini-2.5-flash`; then `openai/gpt-6.1-terra`, `meta/muse-wonder-1.0`, `mistral/mistral-large-4` and `reflection/beam` after `google/gemini-4-argon`. fx has no 5.6 Terra row, so Terra is a new family there.
  - **Hints (D16, "siblings' style"):**
    - Standard rows use the "<ctx> context · <out> output[, note]." form.
    - `catalogOnly` rows priced like premium tiers (Terra, Kimi K3.1 Pro, Muse Wonder) take the standard premium hint.
    - The three that aren't premium-priced (DeepSeek V4.1 Flash 1017, Mistral Large 4, Beam, which is $0) take the `spacexai/grok-4.7` pattern: "<dims> — offered only when this account's catalog includes it." Calling a free model "Premium" would be false.
  - **Labels** follow house style and the Gateway names: "GPT-6.1 Terra", "MiniMax M3.1 Flash", "Muse Spark Open", "Mercury 3", "Kimi K3.1 Pro", "DeepSeek V4.1 Flash 1017", "Muse Wonder", "Mistral Large 4", "Beam 1.0". All are unique, which `types.test.ts:424-425` requires.
- **Cursor (D1, D11, D14).** Three specs appended after `glm-5.2`, in the trailing third-party block, with `effortIds` exactly as `--list-models` shows.
  - `muse-spark-1.3` gets `supportsMaxMode: true`, because the bracket probe was accepted.
  - Neither of the other two gets it; their bracket probes were rejected.
  - None gets `fastEfforts`, since there are no `-fast` ids.
  - `MODEL_EFFORT_SUPPORT.cursor` derives the rest automatically.
- **Migration 075 (D2, D19).** The 074 shape, kind-joined.
  - It uses one `UPDATE` per table, so model and effort move atomically. SQLite evaluates SET expressions against the old row.
  - **P2:** the effort rule is "keep it if 6.1 Sol accepts it (`ultra, max, xhigh, high, medium, low`) or it is NULL; otherwise `high`". D2 names only `none`, but `minimal`, `auto` or junk would 400 the same way, and the rule is a strict superset that changes no row D2 meant to keep.
- **Migration 076 (P1, gap found at plan time).** Adding a Cursor spec makes `cursorModelIdCoveredByCatalog` hide that family's discovered variant rows. A task or Agent that picked one before this release would then render as an unlisted row with a collapsed effort picker.
  - This is the repo's standing convention, followed by every Cursor spec addition: 055 Grok 4.7, 056 Opus 5.5, 060 Sonnet 5.5, 062 Haiku 5.5, 064 Gemini 4 Argon. Fleet knowledge `3c19939d` records it too.
  - 076 folds `<base>-<effort>` into model `<base>` with that effort, for cursor-kind `tasks` and `agent_profiles` and `lastModel:cursor`. It writes `speed = 'off'`, the post-072 column, since no `-fast` form exists.
  - The owner's DBs hold no such rows, but the release reaches other users' DBs.
  - It lives in its own file because the concern differs from 075's (064/066 precedent).
- **Rejected alternatives:**
  - *Tests in a second wave after the data*, the 6.1 Sol precedent. Its wave-1 barrier was knowingly red: the "074 is last" test, the `gpt-5.5` effort test and the fx count assertions all break on the data edit. The skill's green-barrier rule wins, so tests go in the same wave.
  - *Fold 076 into 075.* That mixes a retirement with a normalization and would complicate both tests.
  - *Drive the smoke through a headless core on port 4318.* D8 names `bun run dev`, and the dev app *is* the core on 4318, so the CLI just drives it.
- **Counts (D20).** After T1, with the T0 caveat: fx has **42** curated rows = **16** standard + **26** `catalogOnly`, and **40** effort + **2** no-effort (`minimax/minimax-m3`, `anthropic/claude-haiku-4.5`). Codex has **12** rows / **12** effort keys / **6** floors. Cursor gains **3** specs and **17** covered variant ids. Every task **re-counts from the file after editing; never copy these numbers blind.**

## 4. Work breakdown — implementation tasks

T0 runs before any coding. Its output is §2b of **this file**, appended by T0, and it is the authority for every fx number the Wave-1 briefs quote. If T0 changes nothing, §2b says so, and §2/§3 stand.

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| **T0** | **fx 0.0.14 upgrade and re-measure (D9).** Orchestrator-run, not a parallel agent. (1) Download `https://fx.sh/setup.sh` into the scratchpad and **read it**, then run it to upgrade the owner's global fx; the owner authorized this in D9 (macOS 26 ≥ 15). (2) Run `fx --version`, then `fx status --json` with the real HOME and record `auth`, `auth_expired` and `auth_refreshable`. (3) `HOME=<empty scratch dir> fx models --json` → unauth view; `fx models --json` → signed-in view. Bound every probe with `perl -e 'alarm 60; exec @ARGV'`, since macOS has no `timeout`. (4) With `python3 -I`, for every curated fx id **and** the 9 new ids, record presence in each view and its `models[].efforts`. (5) Reconcile using the rules below. (6) Append **§2b** to this file: versions, both id counts, the per-id table, every row whose effort set or gate changes, and the final counts. **Reconciliation rules:** (a) a new id's effort set is 0.0.14's `efforts` plus `auto`, minus `instant` (D6). If 0.0.14 omits the id from both views, keep the §2 Gateway set and note it. (b) Every curated row present in the signed-in view gets its set compared, and a differing set is updated (D9). (c) The gate follows signed-in presence (D13). (d) If the signed-in view is unusable (expired, not refreshable), keep D13's 139-id gating and say so. (e) **Stop and ask the owner** if a new id is absent from *both* views, or if any change would alter a default. (f) If the upgrade fails, fall back to 0.0.10 and the Gateway sets, and record it (grill A4). | `docs/plans/add-gpt-6-1-terra.md` (append §2b only) | — | §2b exists with both counts and a row for each of the 42 ids. The fx binary reports 0.0.14, or the fallback is recorded. |
| **T1** | **Catalog and contract edits in `src/shared/types.ts`.** Codex, fx and Cursor sub-items listed below the table. | `src/shared/types.ts` | T0 | `bun run typecheck` green. `grep -c "catalogOnly: true" src/shared/types.ts` = 26 (or §2b's number). Codex order is as in §1.1. Every count comment agrees with a re-count. |
| **T2** | **Docs and comment-only count sweep (D20).** CLAUDE.md, README, and the three `src/bun` comments, listed below the table. | `CLAUDE.md`, `README.md`, `src/bun/orchestrator.ts`, `src/bun/agent-discovery.ts`, `src/bun/fx-acp.ts` | T0 | The `src/bun` diffs are comment-only. Counts match T1. `grep -n "retiring 2026-10-14" CLAUDE.md` finds nothing. Typecheck green. |
| **T4** | **Migrations 075 + 076, registration, and their tests.** SQL and test cases listed below the table. | `src/bun/migrations/075_retire_codex_gpt_5_5.sql` (new), `src/bun/migrations/076_normalize_cursor_new_families.sql` (new), `src/bun/migrations/index.ts`, `src/bun/migrate.test.ts` | — | `bun test src/bun/migrate.test.ts` green. A fresh in-memory `migrate(db, migrations)` runs clean through 076. |

**T1 sub-items.**

*Codex.*
- **(a) Models:** insert `{ id: "gpt-6.1-terra", label: "GPT-6.1 Terra", hint: "Fast, efficient model for visual reasoning, computer use and clear writing; replaces GPT-5.6 Terra at about half its price. Needs codex CLI ≥ 0.159 — older CLIs answer a 400 that misleadingly blames the ChatGPT account." }` after `gpt-6.1-sol`. Change the `gpt-5.6-terra` hint to "Balanced GPT-5.6 model — superseded by GPT-6.1 Terra." Delete the `gpt-5.5` row.
- **(b) Effort table:** `MODEL_EFFORT_SUPPORT.codex["gpt-6.1-terra"] = ["ultra","max","xhigh","high","medium","low","none"]` goes after `gpt-6.1-sol`. Add a dated 2026-10-26 paragraph to the evidence comment: catalog first on 0.159.0, low…max + ultra, default low; `none`/`low`/`ultra` live OK on 0.162.1; `minimal` 400; "unlike 6.1 Sol, Terra accepts `none`"; a pointer to this plan. Delete the `"gpt-5.5"` key. Keep the historical 2026-09-03 sentence that mentions gpt-5.5, since it is history.
- **(c) Doc header** (`:3175-3180`): add "GPT-6.1 Terra → none/low/medium/high/xhigh/max (+ Codex-side ultra)". Change "gpt-5.5 / gpt-5 / gpt-5-codex" to "gpt-5 / gpt-5-codex".
- **(d) Floor:** `MODEL_MIN_CLI_VERSION.codex["gpt-6.1-terra"] = "0.159.0"` goes after `gpt-6.1-sol`. Add a doc-comment clause: "gpt-6.1-terra — 0.158.0 ✗ / 0.159.0 ✓ (verified 2026-10-26, docs/plans/add-gpt-6-1-terra.md)".

*fx.*
- **(e) Rows**, positioned as in §3, with hints from §3:
  - MiniMax M3.1 Flash "1M context · 1M output — MiniMax's newest flash tier."
  - Muse Spark Open "1M context · 1M output."
  - Mercury 3 "1M context · 131K output. fx's Instant effort isn't offered here."
  - The premium hint for Terra, Kimi K3.1 Pro and Muse Wonder.
  - DeepSeek V4.1 Flash 1017 "1M context · 1M output — offered only when this account's catalog includes it."
  - Mistral Large 4 "512K context · 262K output — offered only when this account's catalog includes it."
  - Beam 1.0 "1M context · 131K output, coding model — offered only when this account's catalog includes it."
  - **P4:** change the `minimax/minimax-m3` hint to "512K context · 512K output."
- **(f) Effort keys:** add the 9 `MODEL_EFFORT_SUPPORT.fx` keys after `google/gemini-4-argon`, with the §2 sets as amended by §2b, under one dated comment ("2026-10-26: from each id's public Gateway `reasoning_options` plus `auto`, cross-checked against fx 0.0.14's `models[].efforts` (§2b); Mercury 3's `instant` deliberately omitted (D6)"). Apply any §2b changes to existing rows, each with a dated comment.
- **(g) Comments and counts, re-counted:**
  - The `AgentOption.catalogOnly` doc comment: replace the 2026-09-14 "Latest" with 2026-10-26 counts from §2b and the 26-row total.
  - The fx effort-table header gets a 2026-10-26 sentence naming the nine ids, without extending the ordinal chain ("a 36th…"), because retirements broke it.
  - The fx history comment gets a 2026-10-26 paragraph: counts, the 5 standard rows absent from signed-in left in place (D7), the twins discovery-only, the D13 rule, and "16 standard + 26 catalogOnly rows, 42 curated ids total".
  - The `efforts` comment becomes "40 of the 42 … the other 2 (minimax/minimax-m3, anthropic/claude-haiku-4.5)".

*Cursor.*
- **(h) Specs:** append after `glm-5.2`, each under a comment "Ids verified against `cursor-agent --list-models` (2026.10.22-27dcf5f, 2026-10-26)":
  - `"muse-wonder-1.0": { label: "Muse Wonder", hint: "Meta Muse Wonder via Cursor.", effortIds: { max:"muse-wonder-1.0-max", xhigh:"muse-wonder-1.0-xhigh", high:"muse-wonder-1.0-high", medium:"muse-wonder-1.0-medium", low:"muse-wonder-1.0-low", minimal:"muse-wonder-1.0-minimal" } }`, with a comment that the Max Mode bracket was rejected live.
  - `"muse-spark-1.3": { label: "Muse Spark 1.3", hint: "Meta Muse Spark 1.3 via Cursor.", supportsMaxMode: true, effortIds: { …the same six tiers, `muse-spark-1.3-<tier>`… } }`, with a comment that the rows are labeled "1M" and `muse-spark-1.3[context=1m,effort=high]` was accepted live.
  - `"deepseek-v41-flash-1017": { label: "DeepSeek V4.1 Flash 1017", hint: "DeepSeek V4.1 Flash 1017 via Cursor.", effortIds: { max, high, medium, low, none → "deepseek-v41-flash-1017-<tier>" } }`, with a comment that the bracket was rejected live.
  - These close D27's "separate catalog ticket".

**T2 sub-items.**

*`CLAUDE.md` codex bullet.*
- The `MODEL_MIN_CLI_VERSION` parenthetical gains `gpt-6.1-terra → 0.159.0`.
- After the 6.1 Sol default sentence, add: GPT-6.1 Terra (released 2026-10-26; replaces GPT-5.6 Terra at about half its price) sits directly under 6.1 Sol, needs codex ≥ 0.159.0 (0.158.0 answers the same misleading 400), and, unlike 6.1 Sol, accepts `none` live (0.162.1), plus `ultra`. Codex's catalog lists it without `none`, so the live picker shows ultra…low.
- Replace "only GPT-5.5 → GPT-5.6 Sol, retiring 2026-10-14" with the retirement: codex no longer lists GPT-5.5 and a ChatGPT-plan turn 400s. Migration `075_retire_codex_gpt_5_5.sql` moves codex-kind tasks/agent profiles and `lastModel:codex` to `gpt-6.1-sol`, kind-joined (Cursor's `gpt-5.5` spec and fx's `openai/gpt-5.5` are untouched). It maps an effort 6.1 Sol rejects to `high` and leaves frozen snapshots and `lastEffort:codex` alone.
- The `ultra` list gains "GPT-6.1 Terra".

*`CLAUDE.md` fx bullet.*
- "13 standard rows" becomes "16 standard rows". "twenty catalog-gated rows" becomes "twenty-six", with a 2026-10-26 clause naming the six new gated ids and the D13 reason.
- A new sentence after the 2026-10-22 one: "On 2026-10-26 it read N unauthenticated / N signed-in (from §2b; 262 / 139 on 0.0.10) …". It names the 5 standard rows absent from signed-in (left in place, D7).
- The effort-group sentence gains "nine more ids joined on 2026-10-26 from their Gateway `reasoning_options`, cross-checked against fx 0.0.14's `models[].efforts`".
- "refreshed 2026-10-22" gains "extended 2026-10-26".

*`CLAUDE.md` Cursor.* `grep -n "D27\|muse" CLAUDE.md`, and correct any claim that the Muse families are uncurated.

*`README.md`.* Add `### Codex notes` before `### Cursor notes` with one bullet in README voice: "**GPT-5.5 retired.** Codex no longer serves GPT-5.5 on ChatGPT plans. Tasks and Agents on it move to GPT-6.1 Sol when you upgrade; an effort GPT-6.1 Sol doesn't offer, like *No thinking*, becomes *High*." This is the fx `:99` precedent.

*Comment-only `src/bun` edits.*
- **`orchestrator.ts:6538-6552`:** rewrite the count sentence to "40 of its 42 curated models advertise real efforts (`MODEL_EFFORT_SUPPORT.fx`, refreshed against fx 0.0.14's `models[].efforts` on 2026-10-22 and extended 2026-10-26)". Replace the ordinal history with that pointer, and make the no-effort tail "only the remaining 2 no-effort fx models (`minimax/minimax-m3`, `anthropic/claude-haiku-4.5`)". The `zai/glm-4.7` example is stale; it has a set now.
- **`agent-discovery.ts:548-555` and `fx-acp.ts:510-515`:** add "the nine ids curated 2026-10-26 (…list…)" to each "postdate this measurement" enumeration. Leave the historical 28/16/12 measurement text alone.

**T4 SQL.**

`075`:

```sql
UPDATE tasks
SET model = 'gpt-6.1-sol',
    effort = CASE WHEN effort IS NULL OR effort IN ('ultra','max','xhigh','high','medium','low') THEN effort ELSE 'high' END
WHERE model = 'gpt-5.5' AND agent IN (SELECT id FROM harnesses WHERE kind = 'codex');
```

- The same statement runs on `agent_profiles`, joined via `harness_id`.
- Then: `UPDATE preferences SET value = 'gpt-6.1-sol' WHERE key = 'lastModel:codex' AND value = 'gpt-5.5';`
- The header comment follows 074's: why it is retired (§2), why the join is load-bearing (the Cursor key `gpt-5.5`, fx `openai/gpt-5.5`), the effort rule (P2), what it doesn't touch (D19), and that it is one-way and idempotent.

`076`:
- For each family `B` in (`muse-wonder-1.0`, `muse-spark-1.3`, `deepseek-v41-flash-1017`): `UPDATE tasks SET effort = substr(model, length('B-') + 1), speed = 'off', model = 'B' WHERE model IN (<the exact variant ids from T1(h)>) AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');`
- The same statement runs on `agent_profiles` (`harness_id`).
- Then: `UPDATE preferences SET value = 'B' WHERE key = 'lastModel:cursor' AND value IN (<variants>);`
- Use explicit `IN` lists, never `LIKE`, so an unknown future suffix isn't folded into a bogus effort.
- The header comment follows 064's.

**T4 registration.** Add `import m075 …`, `import m076 …` and append `{ id: "075_retire_codex_gpt_5_5", sql: m075 }, { id: "076_normalize_cursor_new_families", sql: m076 }`.

**T4 test edits** (`migrate.test.ts`).
- **(i)** Change the "074 … is the last registered migration" test to assert 074 sits right after 073/072/071, without the `length - 1` check.
- **(ii)** New: "076 is the last registered migration, right after 075, which is right after 074". It also asserts each `sql` matches its imported file.
- **(iii)** The 075 data test uses `makeModelMigrationDb` with harnesses `codex`, `codex-2` (kind codex), `cursor` and `fx`. It runs the SQL twice and asserts:
  - The second run is a no-op.
  - Codex `gpt-5.5` rows move, with these effort results: `none` → `high`, `minimal` → `high`, `xhigh` kept, `medium` kept, NULL kept, and the extra codex harness is covered by the kind join.
  - Untouched: a codex `gpt-6-sol` row with `none` (legit there), a cursor `gpt-5.5` row with effort `none`, fx rows on `openai/gpt-5.5` **and** on the literal `gpt-5.5` (the kind-join control), and an orphan `deleted-codex` row.
  - Profiles follow the same matrix.
  - Preferences: `lastModel:codex` `gpt-5.5` → `gpt-6.1-sol`. `lastModel:cursor` `gpt-5.5` and `lastEffort:codex` `none` are untouched.
- **(iv)** The 076 data test uses a post-072 seed schema with `speed TEXT NOT NULL DEFAULT 'off'`. Add a helper variant or option; don't edit the existing helper's columns, since 074's test relies on them. It asserts:
  - Every one of the 17 variant ids folds to base + effort, with `speed` going from `fast` to `off`.
  - Untouched: base ids, an fx `meta/muse-wonder-1.0` row, a codex row carrying a cursor literal, an unknown `muse-wonder-1.0-ultra`, and an orphan.
  - Profiles and `lastModel:cursor` are normalized; a live cursor pick is left alone.
  - A rerun is a no-op.

## 5. Work breakdown — test tasks

Wave-1 test tasks code against the values pinned in §3/§4, as amended by §2b, so they land beside the data and the barrier stays green.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| **T5** | unit + integration | T1 codex + Cursor | `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`, `src/bun/orchestrator-min-cli-version.test.ts`, `src/cli/config.test.ts`, `src/bun/claude-local-setting.test.ts` | Named files green. Each new assertion fails against `c5cf1a2`. |
| **T6** | unit + e2e copy | T1 fx | `src/shared/types.test.ts`, `e2e/fx-models.spec.ts` | `bun test src/shared/types.test.ts` green. The e2e file parses (`bun run typecheck` covers it, if e2e is in the tsconfig; otherwise run the spec, §5 recipe). |
| **T7** | unit | T1 end to end through the real picker merge | `src/shared/gpt-6-1-terra-catalog.test.ts` (new) | Green. Each case fails against `c5cf1a2`. |

**T5 edits.**

*`effort-support.test.ts`.*
- New: "codex GPT-6.1 Terra supports ultra through none (none + ultra live on 0.162.1; minimal 400s)" → `["ultra","max","xhigh","high","medium","low","none"]`.
- Picker-order test: assert the **full** 12-id list in §1.1 order, and rename it.
- Replace the `gpt-5.5` effort test with "codex gpt-5.5 is retired: no codex row, no codex effort key, while the Cursor gpt-5.5 spec stays" (`CURSOR_MODEL_SPECS["gpt-5.5"]` defined).
- `MODEL_MIN_CLI_VERSION` test: exactly **six** ids, including `"gpt-6.1-terra": "0.159.0"`, and rename "five" to "six".
- Cursor: one test per new spec.
  - `muse-spark-1.3`: efforts `max…low, minimal`; `cursorModelSupportsMaxMode` true; `cursorModelArg("muse-spark-1.3","high",false,true)` === `"muse-spark-1.3[context=1m,effort=high]"`; `cursorModelArg(…, null, false)` === `"muse-spark-1.3-high"`; fast false.
  - `muse-wonder-1.0`: same efforts; Max Mode false; `cursorModelArg("muse-wonder-1.0", null, true, true)` === `"muse-wonder-1.0-high"`.
  - `deepseek-v41-flash-1017`: `["max","high","medium","low","none"]`; Max Mode false; `"…-none"` composes.
  - All 17 variant ids satisfy `cursorModelIdCoveredByCatalog`, and the three ids follow `glm-5.2` in `AGENT_OPTIONS.cursor.models`.

*`agents.test.ts`.* Retarget the `gpt-5.5` passthrough test to `gpt-6.1-terra`. Add "codex gpt-6.1-terra with effort none emits `-c model_reasoning_effort=none`".

*`orchestrator-min-cli-version.test.ts`.* Add "codex 0.158.0 + gpt-6.1-terra is refused before any run row is created" (error names 0.158.0 and 0.159.0, column unchanged, no run rows) and "codex 0.159.0 + gpt-6.1-terra is allowed to start". Copy the 6.1 Sol pair at `:196-229`.

*`config.test.ts` and `claude-local-setting.test.ts`.* Retarget the incidental codex `gpt-5.5` literals to `gpt-6.1-terra`. Assertions are unchanged.

**T6 edits.**

*`types.test.ts`.*
- `FX_EFFORT_MODELS` gains the 9 sets, plus any §2b changes, each with a dated comment.
- `31` → `40`, and both `33`s → `42`. Re-count from the file.
- The `expectedCatalogOnly` set gains the 6 ids under a 2026-10-26 comment. `size 26`. Test names "twenty" → "twenty-six" (`:319`, `:373`).
- Add: the three new standard ids are non-`catalogOnly`.
- Add: `deepseek/deepseek-v4.1-flash-1017` is at index 1 and the default is still at index 0.
- Add: each successor's index is one less than its predecessor's (M3.1 Flash / M3, Kimi K3.1 Pro / K3).

*`e2e/fx-models.spec.ts`.*
- `EXCLUDED_FX_OPTION_LABELS` gains the 9 new labels, all absent from the frozen 4-id stub, under a dated comment.
- The prose "two ordinary curated rows … twelve of the twenty" becomes "five … eighteen of the twenty-six". Re-count from the file.

**T7 cases**, modeled on `gemini-4-argon-catalog.test.ts`, all through `mergeModelOptions` over the real `AGENT_OPTIONS`:

*Codex.*
1. A discovered catalog listing `gpt-6.1-sol, gpt-6.1-terra` shows Terra directly after 6.1 Sol, with a curated label and no `unlisted`.
2. With discovery empty, Terra still shows (codex isn't catalog-scoped).
3. A stored `gpt-5.5` selection renders as an `unlisted` row. This is the post-retirement path for frozen snapshots.

*fx.*

4. Each of the 6 `catalogOnly` ids shows when discovered, and is hidden when discovery is empty or the harness is logged out (rule 7).
5. A catalog shaped like the signed-in view (the default plus the 3 new standard ids, without the 6) shows the 3 standard rows and none of the 6.
6. When discovered, DeepSeek V4.1 Flash 1017 renders second.

*Cursor.*

7. Discovered variant ids of the 3 families are filtered from the picker (`cursorModelIdCoveredByCatalog`), leaving the base rows.

**e2e: not applicable (D8).** Every change is data or copy riding surfaces that already have coverage. There is no new component, route or flow. The floor is pinned at the orchestrator layer like every other floor, and the migrations at the migrate layer. `e2e/fx-models.spec.ts` gets label/prose edits only, so it stays truthful against its frozen stub.

**Run recipe.**

1. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun install`.
2. `bun run typecheck`.
3. Targeted:

   ```sh
   bun test src/shared/types.test.ts src/shared/gpt-6-1-terra-catalog.test.ts src/shared/gemini-4-argon-catalog.test.ts src/shared/speed.test.ts src/bun/effort-support.test.ts src/bun/agents.test.ts src/bun/orchestrator-discovered-efforts.test.ts src/bun/orchestrator-min-cli-version.test.ts src/bun/orchestrator-codex-queue-floor.test.ts src/bun/clone-endpoint.test.ts src/bun/agent-discovery.test.ts src/bun/migrate.test.ts src/bun/claude-local-setting.test.ts src/cli/config.test.ts src/shared/cli-version.test.ts
   ```

4. Full `bun test`, one suite at a time across agents.
   - Check `uptime` first: the CLI suite stalls at load 30+.
   - Known pre-existing failures are tmux-socket ×2 and one reconcile-cancel test. Report them as pre-existing, never "fix" them here.
5. Optional, only because T6 edits it: `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts`. Use the CLI script, not `bunx`, and run one Playwright run at a time.

**Verification tasks** run in Wave 2, orchestrator-run, with no repo edits besides §10 of this file.

**V1 — migration dry run on a dev-DB copy (D8).**
1. `cp ~/.agetor-dev/agetor.sqlite* <scratchpad>/devcopy/`, including `-wal`/`-shm` if present.
2. A scratchpad `bun` script, run from the worktree, opens the **copy** with `bun:sqlite` and calls `migrate(db, migrations.slice(0, i074 + 1))`. The copy is at 051, so this goes 051 → 074.
3. The script seeds synthetic rows: codex-kind `gpt-5.5` with efforts `none`/`high`; cursor `gpt-5.5`; fx `openai/gpt-5.5`; a cursor `muse-wonder-1.0-low` task; `lastModel:codex = gpt-5.5`; `lastModel:cursor = deepseek-v41-flash-1017-max`.
4. It calls `migrate(db, migrations)` and prints the rows and `_migrations`.
5. It reruns `migrate` and asserts no change.
6. **Never open `~/.agetor-dev/agetor.sqlite` itself in V1, and never touch `~/.agetor`.**
- Expected: as in the T4 tests, with `_migrations` ending in 075 and 076.

**V2 — live smokes in the dev app (D8).**
1. Run `bun run dev:hmr` in the background. It uses `~/.agetor-dev` and port 4318, and launching it migrates the dev DB to 076, which is expected.
2. Wait for `curl -s 127.0.0.1:4318/health`.
3. Drive it with `bun src/cli/index.ts --data-dir ~/.agetor-dev --port 4318 …`. Before the first mutating call, run `… ls --json` and confirm the core answering on 4318 is the dev one, by its task list matching `sqlite3 -readonly ~/.agetor-dev/agetor.sqlite`. Memory: the CLI can otherwise reach the prod core.
4. Enable the codex, cursor and fx harnesses in the dev DB. Check `… harness --help` for the flag, or use Settings → Harnesses in the dev window.
5. Create a scratch git repo in the scratchpad as the workdir, with isolation `none`.
6. Run, one at a time:
   - **(a)** codex `--model gpt-6.1-terra --effort low --mode ask "Reply with exactly OK"` → the run succeeds with "OK". The `mode=` breadcrumb shows `ask`.
   - **(b)** fx `--model minimax/minimax-m3.1-flash --effort low --mode yolo "Reply with exactly OK"`. Run it once, paced: the free-tier 429 storm is known (memory). Expect success, **and no** "effort … isn't offered" breadcrumb.
   - **(c)** cursor `--model deepseek-v41-flash-1017 --effort low --mode ask "Reply with exactly OK"` → argv `--model deepseek-v41-flash-1017-low`, success.
7. Optional owner eyeball in the dev window: the codex picker shows GPT-6.1 Terra under GPT-6.1 Sol.
8. Delete the smoke tasks afterwards (memory: test cleanup) and stop the dev app.
9. Record each run's outcome and any breadcrumb in a new **§10 Verification log** of this file.
- If (b) hits the 429 storm and pauses, record it. It is not a product failure, and the paused session resumes via `agetor resume`.

## 6. Execution waves

- **Wave 0 (sequential, orchestrator):** T0. **Barrier:** §2b written. If rule (e) fired, stop and ask the owner before Wave 1. Commit `wave 0: fx 0.0.14 re-measure (plan §2b)`.
- **Wave 1 (parallel, file-disjoint): T1, T2, T4, T5, T6, T7.**
  - Owned files are pairwise disjoint (checked):
    - T1 `types.ts`.
    - T2 `CLAUDE.md`, `README.md`, `orchestrator.ts`, `agent-discovery.ts`, `fx-acp.ts`.
    - T4 `075…sql`, `076…sql`, `migrations/index.ts`, `migrate.test.ts`.
    - T5 `effort-support.test.ts`, `agents.test.ts`, `orchestrator-min-cli-version.test.ts`, `src/cli/config.test.ts`, `claude-local-setting.test.ts`.
    - T6 `types.test.ts`, `e2e/fx-models.spec.ts`.
    - T7 `gpt-6-1-terra-catalog.test.ts`.
  - The test tasks code against the values pinned in §3/§4 (+§2b), never against T1's in-progress file.
  - **Barrier:** typecheck + the targeted run + full `bun test` green, apart from the three known failures. Commit `wave 1: GPT-6.1 Terra + new fx/Cursor models, retire codex gpt-5.5 (migrations 075/076), tests, docs`.
- **Review (Phase 5):** code review of `git diff c5cf1a2...HEAD`. Also check that every count is re-counted, not copied (the 6.1 Sol review found a misplaced comment row; check row-under-its-own-comment placement).
- **Wave 2 (sequential, orchestrator):** V1, then V2. **Barrier:** §10 written. Commit `wave 2: verification log`.
- **Wave 3 (only if review or verification finds anything):** fixes, partitioned by the same file ownership. Re-run the Wave-1 barrier, plus V1 if a migration changed.

## 7. Blast radius & risks

- **Migration 075 is one-way** (like 074). In prod it moves **10 archived codex tasks** (effort `high`, so no fix-up), 0 profiles, and no preference. In dev it moves nothing.
  - An unarchived and resumed ex-gpt-5.5 task now resumes its codex thread with `--model gpt-6.1-sol`. On gpt-5.5 it would 400 anyway, so this is strictly better.
  - Frozen `agent_profile` / `pipeline_run` snapshots still say `gpt-5.5`. Re-running such a frozen step 400s with codex's own message (D19, accepted).
  - Bundle import of a codex `gpt-5.5` Agent shows an `unknown-model` warning only (`bundle-import.ts`), which is honest.
  - Rollback means a new migration, never an edit to 075.
- **The kind join is load-bearing:** `gpt-5.5` is a live Cursor spec (`types.ts:2768`) and an fx literal. The T4 test's control rows guard this.
- **Migration 076** is a no-op on the owner's DBs. For other users it rewrites only exact variant ids on cursor-kind rows. `cursorModelArg` re-composes the same `--model` argv (base + effort → `<base>-<effort>`), so a run is unchanged. A stored `-fast` doesn't exist for these families.
- **Floor:** additive. The only new refusal is codex < 0.159.0 + Terra, which fails today anyway, after a run row and worktree exist. The owner's 0.162.1 passes. `AGETOR_SKIP_CLI_VERSION_FLOOR=1` still bypasses it (A1).
- **fx:**
  - The owner's signed-in account newly sees MiniMax M3.1 Flash, Muse Spark Open and Mercury 3. Nothing else changes there unless §2b moves a gate.
  - `catalogOnly` is fail-closed.
  - A wrong curated effort set only affects the picker. `applyFxEffort` degrades to a breadcrumb at runtime, and discovered `models[].efforts` win once fx 0.0.14 is installed.
- **Cursor:** the 17 variant ids stop appearing as discovered-only rows. `muse-spark-1.3` Max Mode was probed live (§2). The others never emit the bracket.
- **Machine side effect:** T0 upgrades the owner's **global** fx to 0.0.14 (authorized in D9). It is reversible by re-running fx's setup for 0.0.10. Grill A4 records the fallback.
- **The dev app migrates `~/.agetor-dev` from 051 to 076** on first launch. That is the dev dir's purpose (memory: dogfood in dev dir), and `bun run wipe:dev` resets it.
- **Unchanged:** no schema change beyond these data migrations, no route-shape change, `ALLOWED_PATCH_FIELDS`, and every default.

## 8. Open questions / assumptions

**Plan-time additions.** These weren't grilled. The owner answered P1–P4 and P7 at hand-off on 2026-10-26, choosing the bold recommendation each time. P5 and P6 are execution details the plan approval covers.

- **P1 — Migration 076 (Cursor variant normalization)** for the three new families. **Recommended: include it.** It is the repo convention for every Cursor spec addition (055/056/060/062/064) and fleet knowledge `3c19939d`. Without it, a variant a user picked from discovery renders as an unlisted row with a collapsed effort picker.
- **P2 — The 075 effort rule** is "anything 6.1 Sol rejects → `high`" rather than only `none`. **Recommended: the wider rule.** It is a strict superset of D2 and changes no row D2 keeps; `minimal`/`auto` on a codex row would 400 the same way.
- **P3 — fx `deepseek/deepseek-v4.1-flash-1017` sits at index 1**, a `catalogOnly` row inside the standard block, directly below the default. That is D14's "next to DeepSeek V4 Flash", constrained by the default-first pin. **Alternative:** put it in the `catalogOnly` block beside `deepseek/deepseek-v4-pro`.
- **P4 — Fix the `minimax/minimax-m3` hint** to "512K context · 512K output", which is what the Gateway reports today. It sits directly under the new M3.1 Flash row, so the wrong figure would be visible side by side. A wider sweep of standard-row context figures is out (§9).
- **P5 — Hint style for non-premium gated rows:** DeepSeek V4.1 Flash 1017, Mistral Large 4 and Beam (which is $0) use the `grok-4.7` "<dims> — offered only when…" form, not "Premium Gateway tier".
- **P6 — How V2 is driven:** `bun run dev:hmr` (D8's dev app) driven by the CLI against port 4318, with an explicit dev-core identity check before any mutation.
- **P7 — README** gains a small `### Codex notes` section for the retirement, mirroring the fx retired-models bullet.

**Carried from the grill:**
- **A1:** the 0.159.0 floor also gates API-key accounts (bypass: `AGETOR_SKIP_CLI_VERSION_FLOOR`).
- **A2:** Terra's `ultra` follows codex's catalog.
- **A3:** T0 may move a model across the `catalogOnly` line; D13 decides, and every count follows the file.
- **A4:** the fx 0.0.14 upgrade is non-disruptive, with a fallback recorded.
- **A5:** codex may run Terra on its "priority" (Fast) tier by default. Not probed; cosmetic; out of scope (D18).
- **A6:** Kimi K3.1 Pro has thin web corroboration; the `catalogOnly` gate is fail-closed.
- **A7 is now closed:** prod has 10 archived codex `gpt-5.5` tasks at `high`, 0 profiles, and the preference already on 6.1 Sol. Dev has 0.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Codex Terra row, hint, effort entry, floor, doc-header line | in this run | T1; tests T5, T7 |
| fx Terra `catalogOnly` row + effort entry | in this run | T1; tests T6, T7 |
| 8 new fx rows (3 standard, 5 `catalogOnly`) with effort sets and hints | in this run | T1 (D1); tests T6, T7 |
| 3 new Cursor specs (effortIds, Max Mode per probe) | in this run | T1 (D1, reverses D27); tests T5, T7 |
| fx effort sets reconciled against fx 0.0.14 `models[].efforts` (new + existing signed-in rows); global fx upgrade | in this run | T0 → T1/T6 (D9) |
| Codex `gpt-5.5` retirement: row, effort key, doc-header mention, its test, hint | in this run | T1, T5 (D2) |
| Migration 075 (tasks, agent_profiles, `lastModel:codex`, effort fix-up) + registration + tests (incl. kind-join controls, rerun no-op) | in this run | T4 (D2, D19, D21; P2) |
| "074 is the last migration" test that 075 breaks | in this run | T4 |
| Cursor variant-id normalization for the 3 families (tasks, agent_profiles, `lastModel:cursor`) | in this run | T4 (P1, 055–064 convention) |
| GPT-5.6 Terra hint naming its true successor | in this run | T1 (D16) |
| Incidental codex `gpt-5.5` test literals (`config.test.ts`, `claude-local-setting.test.ts`, `agents.test.ts` passthrough) | in this run | T5 |
| Every fx count comment and assertion (`types.ts` ×4, `orchestrator.ts`, `agent-discovery.ts`, `fx-acp.ts`, `types.test.ts`, e2e prose, CLAUDE.md) | in this run, in lockstep, re-counted | T1, T2, T6 (D20) |
| Pre-existing stale `orchestrator.ts:6538` "23 of its 36" + stale `zai/glm-4.7` example | in this run | T2 (D20) |
| `AgentOption.catalogOnly` doc-comment counts (2026-09-14) | in this run | T1 (D20) |
| CLAUDE.md codex bullet (floor, Terra sentence, ultra list, retirement sentence) and fx bullet | in this run | T2 (D20) |
| README user-facing note for the codex retirement | in this run | T2 (P7) |
| `minimax/minimax-m3` hint context figure (Gateway now 512K/512K) | in this run | T1 (P4) |
| Migration dry run on a dev-DB copy; live codex/fx/cursor smokes | in this run | V1, V2 (D8) |
| Cursor `gpt-5.5` spec and fx `openai/gpt-5.5` row | kept (not retired) | live models on those harnesses; the 075 join protects them |
| Frozen profile/pipeline snapshots naming `gpt-5.5` | out of scope | D19 / 074 rule: snapshots are history |
| GPT-6 Astra Aeon retirement or rewording | declined | owner (D3) |
| fx standard rows absent from signed-in (gpt-5.4-mini, grok-4.6, minimax-m3, qwen3.8-flash, glm-5.3-flash) | declined (stay standard; comments refreshed) | owner (D7) |
| Mercury 3 `instant` effort | declined | owner (D6) |
| Codex hidden `gpt-reserve` | declined | owner (D17) |
| Cursor Terra spec | out of scope | no `gpt-6*` ids in cursor-agent 2026.10.22 (D17) |
| Codex Fast service tier in the Speed picker (incl. A5) | out of scope | separate feature (D18) |
| `-fast` / `-highspeed` / `-free` Gateway twins | out of scope | discovery-only by house rule (D13) |
| Any harness default change | declined | owner (D5, D15) |
| Re-checking every *other* standard fx hint's context figures against the Gateway | out of scope | pre-existing copy drift unrelated to these models; P4 fixes only the row adjacent to a new successor |
| Historical "28 then-curated" measurement prose in `agent-discovery.ts` / `fx-acp.ts` | kept as history | only the "postdate" enumerations are extended (T2) |
| Owner-deferred items | none | — |

## 10. Verification log

- **Wave 1 barrier (2026-10-26):** `bun run typecheck` green; targeted 15-file run 715 pass / 0 fail; full `bun test` 8566 pass / 2 skip / 0 fail (the three known pre-existing failures did not occur this run).
- **V1 — migration dry run on a dev-DB copy:** the scratch copy (never `~/.agetor-dev` itself) migrated 051 → 074 (23 migrations), then 075 and 076. Codex `gpt-5.5`/`none` → `gpt-6.1-sol`/`high`; codex `gpt-5.5`/`high` → `gpt-6.1-sol`/`high`; cursor `gpt-5.5`/`none` and fx `openai/gpt-5.5` untouched; cursor `muse-wonder-1.0-low` → `muse-wonder-1.0`/`low`, `speed` `off`; `lastModel:codex` → `gpt-6.1-sol`; `lastModel:cursor` `deepseek-v41-flash-1017-max` → `deepseek-v41-flash-1017`; `updated_at` unchanged; `_migrations` ends 074, 075, 076; a rerun applied nothing and changed nothing.
- **V2 — live dev-app smokes:** not run yet (plan places it after review, Wave 2).
